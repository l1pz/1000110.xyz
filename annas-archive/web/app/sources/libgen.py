"""Libgen: the fallback source, and the only one that needs no cookie at all.

Anna's Archive's free download is nicer when it works (better metadata, no ads), but it can be
blocked, so the worker retries here by title + author. Two steps: `ads.php?md5=…` hands out a
short-lived key, `get.php?md5=…&key=…` redirects to a CDN that serves the file.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Callable
from pathlib import Path

import httpx
from bs4 import BeautifulSoup

from ..config import BROWSER_HEADERS
from ..models import Result

HUNGARIAN = re.compile(r"^(hungarian|magyar)$", re.I)
KEY_PATTERN = re.compile(r"get\.php\?md5=([a-f0-9]{32})&key=([A-Z0-9]+)", re.I)
SIZE_PATTERN = re.compile(r"([\d.,]+)\s*([kmgt]?)b", re.I)
UNITS = {"": 1, "k": 1024, "m": 1024**2, "g": 1024**3, "t": 1024**4}


class SourceUnavailable(Exception):
    """Libgen has no usable copy of this book."""


def _text(node) -> str:
    return unicodedata.normalize("NFC", " ".join(node.get_text(" ", strip=True).split()))


def _size(text: str) -> int:
    match = SIZE_PATTERN.search(text)
    if not match:
        return 0
    number = match.group(1).replace(",", ".")
    try:
        return int(float(number) * UNITS[match.group(2).lower()])
    except ValueError:
        return 0


def parse_search(html: str) -> list[Result]:
    soup = BeautifulSoup(html, "html.parser")
    table = soup.find("table", id="tablelibgen")
    body = table.find("tbody") if table else None
    if not body:
        return []
    results: list[Result] = []
    for row in body.find_all("tr", recursive=False):
        cells = row.find_all("td", recursive=False)
        if len(cells) < 9:
            continue
        language = _text(cells[4])
        if not HUNGARIAN.match(language):
            continue
        md5_match = re.search(r"ads\.php\?md5=([a-f0-9]{32})", str(cells[8]))
        if not md5_match:
            continue
        titles = [_text(a) for a in cells[0].find_all("a", href=lambda h: h and h.startswith("edition.php"))]
        title = max(titles, key=len, default="").strip()
        if not title:
            continue
        year_text = _text(cells[3])
        year = int(year_text) if year_text[:4].isdigit() else None
        results.append(
            Result(
                title=title,
                author=_text(cells[1]),
                publisher=_text(cells[2]),
                year=year,
                language="hu",
                format=_text(cells[7]).upper(),
                size=_size(_text(cells[6])),
                md5=md5_match.group(1),
                source="libgen",
            )
        )
    return results


def parse_ads_key(html: str) -> str:
    match = KEY_PATTERN.search(html)
    return match.group(2) if match else ""


def filename_from_disposition(value: str) -> str:
    """`attachment; filename="x.epub"` (also the RFC 5987 `filename*=` form) → x.epub."""
    if not value:
        return ""
    match = re.search(r"filename\*=(?:UTF-8'')?([^;]+)", value, re.I)
    if match:
        from urllib.parse import unquote

        return unquote(match.group(1).strip().strip('"'))
    match = re.search(r'filename="?([^";]+)"?', value, re.I)
    return match.group(1).strip() if match else ""


class LibgenSource:
    def __init__(self, base_url: str, timeout: float = 60.0):
        self.base_url = base_url.rstrip("/")
        self._timeout = timeout

    def _get(self, path: str, *, follow: bool = True) -> httpx.Response:
        url = path if path.startswith("http") else self.base_url + path
        with httpx.Client(
            headers=BROWSER_HEADERS, timeout=self._timeout, follow_redirects=follow, max_redirects=8
        ) as client:
            return client.get(url)

    def search(self, query: str) -> list[Result]:
        params = {"req": query, "res": "50", "topics[]": "f"}
        response = self._get("/index.php?" + str(httpx.QueryParams(params)))
        return parse_search(response.text)

    def download(self, md5: str, dest: Path) -> str:
        ads = self._get(f"/ads.php?md5={md5}")
        key = parse_ads_key(ads.text)
        if not key:
            raise SourceUnavailable("a Libgen nem adott letöltési kulcsot")
        response = self._get(f"/get.php?md5={md5}&key={key}")
        if response.status_code != 200 or not response.content:
            raise SourceUnavailable(f"a Libgen letöltés {response.status_code} választ adott")
        dest.write_bytes(response.content)
        return dest.name


def find_match(results: list[Result], title: str, author: str) -> Result | None:
    """Pick the closest Libgen row for a book we know by title (and maybe author)."""
    def norm(value: str) -> str:
        return re.sub(r"[^a-z0-9]+", " ", (value or "").lower()).strip()

    wanted = norm(title)
    if not wanted:
        return None
    scored = []
    for result in results:
        candidate = norm(result.title)
        score = 0
        if candidate == wanted:
            score = 100
        elif wanted in candidate or candidate in wanted:
            score = 60
        else:
            words = {w for w in wanted.split() if len(w) > 2}
            if words:
                score = int(40 * len(words & set(candidate.split())) / len(words))
        if score and author and norm(author) and norm(author) in norm(result.author):
            score += 15
        scored.append((score, result))
    scored.sort(key=lambda pair: pair[0], reverse=True)
    return scored[0][1] if scored and scored[0][0] >= 40 else None