"""Anna's Archive: search, metadata and the free "slow download" path.

Two things make this source unusual:

* The site sits behind DDoS-Guard. A cookieless request gets a 403 challenge page; once
  `aa_ddg_check` (a 90-day, IP-bound token minted by the browser, see `harvest.py`) and `__ddg5_`
  are in the jar, everything here is plain HTTP.
* The free download has a per-file countdown (about 41 seconds). The worker calls `download()` in a
  thread, so sleeping is fine; the phone already has its "átkerül a Kindle-re" screen by then.

The parse functions are pure and pinned by tests against real pages (`tests/fixtures/`).
"""

from __future__ import annotations

import re
import time
import unicodedata
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import httpx
from bs4 import BeautifulSoup

from ..config import BROWSER_HEADERS
from ..models import Result

SITE_NAME = re.compile(r"\s*[-–]\s*Anna.s Archive\s*$")
META_LINE = re.compile(
    r"((?:[^·]{0,30}\[[a-z]{2}\]\s*·\s*)+)([A-Z0-9]{2,5})\s*·\s*([\d.]+)\s*([KMG])B(?:\s*·\s*(\d{4}))?"
)
SIZE_UNITS = {"K": 1024, "M": 1024**2, "G": 1024**3}


class ChallengeRequired(Exception):
    """DDoS-Guard answered instead of the site: the clearance cookie is missing or expired."""


class SourceUnavailable(Exception):
    """The source cannot serve this book right now (no link, blocked, malformed page)."""


@dataclass
class Details:
    title: str
    author: str = ""
    publisher: str = ""
    year: int | None = None
    language: str = "hu"
    format: str = ""
    size: int | None = None
    original_path: str = ""

    @property
    def filename(self) -> str:
        base = self.original_path.rsplit("/", 1)[-1].strip()
        return base or f"{self.title}.{self.format.lower() or 'epub'}"


def _soup(html: str) -> BeautifulSoup:
    return BeautifulSoup(html, "html.parser")


def _text(node) -> str:
    return unicodedata.normalize("NFC", " ".join(node.get_text(" ", strip=True).split()))


def _meta(text: str) -> tuple[str, str, int, int | None]:
    """(language, format, size bytes, year) out of '… [hu] · EPUB · 1.2MB · 1994 · …'."""
    match = META_LINE.search(text)
    if not match:
        return "", "", 0, None
    languages, fmt, number, unit, year = match.groups()
    language = re.search(r"\[([a-z]{2})\]", languages)
    size = int(float(number) * SIZE_UNITS[unit]) if unit else 0
    return (language.group(1) if language else ""), fmt, size, int(year) if year else None


def parse_search(html: str) -> list[Result]:
    soup = _soup(html)
    rows = [
        node
        for node in soup.find_all("div")
        if node.get("class") and "pt-3" in node["class"] and "pb-3" in node["class"]
    ]
    results: list[Result] = []
    for row in rows:
        md5_match = re.search(r"/md5/([a-f0-9]{32})", str(row))
        if not md5_match:
            continue
        title_node = row.select_one("a.js-vim-focus")
        if title_node is None:
            title_node = max(
                (a for a in row.select("a[href^='/md5/']")), key=lambda a: len(_text(a)), default=None
            )
        title = _text(title_node) if title_node else ""
        if not title:
            continue
        text = _text(row)
        language, fmt, size, year = _meta(text)
        author = ""
        for link in row.select("a[href^='/search?q=']"):
            icon = link.select_one("span")
            if icon and any("mdi--user-edit" in name for name in icon.get("class") or []):
                author = _text(link)
                break
        path_node = row.select_one("div.font-mono")
        results.append(
            Result(
                title=title,
                author=author,
                year=year,
                language=language or "hu",
                format=fmt,
                size=size,
                md5=md5_match.group(1),
                source="annas",
                original_path=path_node.get_text().strip() if path_node else "",
            )
        )
    return results


def parse_details(html: str) -> Details:
    soup = _soup(html)
    title = _text(soup.title) if soup.title else ""
    title = SITE_NAME.sub("", title).strip()
    text = _text(soup.select_one("main") or soup)
    language, fmt, size, year = _meta(text)

    author = ""
    for link in soup.select("a[href^='/search?q=']"):
        icon = link.select_one("span")
        if icon and any("mdi--user-edit" in name for name in icon.get("class") or []):
            author = _text(link)
            break
    publisher = ""
    for link in soup.select("a[href^='/search?q=']"):
        icon = link.select_one("span")
        if icon and any("mdi--company" in name for name in icon.get("class") or []):
            publisher = _text(link)
            break
    path_node = soup.select_one("div.font-mono")
    return Details(
        title=title,
        author=author,
        publisher=publisher,
        year=year,
        language=language or "hu",
        format=fmt,
        size=size,
        original_path=path_node.get_text().strip() if path_node else "",
    )


def parse_download_slots(html: str, md5: str) -> list[str]:
    slots = []
    for folder, index in re.findall(rf"/slow_download/{md5}/(\d+)/(\d+)", html):
        slot = f"/slow_download/{md5}/{folder}/{index}"
        if slot not in slots:
            slots.append(slot)
    return slots


def parse_slow_page(html: str) -> tuple[int, str]:
    """(seconds still to wait, partner URL). Exactly one of them is meaningful."""
    soup = _soup(html)
    countdown = soup.select_one(".js-partner-countdown")
    if countdown:
        digits = re.sub(r"\D", "", countdown.get_text())
        return (int(digits) if digits else 0), ""
    for link in soup.select("a[href]"):
        if "Download now" in _text(link) and link["href"].startswith("http"):
            return 0, link["href"]
    return 0, ""


class AnnaSource:
    def __init__(
        self,
        base_url: str,
        cookies: Callable[[], dict[str, str]],
        refresh: Callable[[], bool] | None = None,
        save: Callable[[dict[str, str]], None] | None = None,
        timeout: float = 60.0,
    ):
        self.base_url = base_url.rstrip("/")
        self._cookies = cookies
        self._refresh = refresh
        self._save = save
        self._timeout = timeout

    # -- plumbing --------------------------------------------------------

    def _get(self, path: str, *, follow: bool = True) -> httpx.Response:
        url = path if path.startswith("http") else self.base_url + path
        # The clearance cookies belong to annas-archive; never hand them to the partner CDN.
        ours = url.startswith(self.base_url)
        for attempt in (0, 1):
            try:
                with httpx.Client(
                    headers=BROWSER_HEADERS,
                    cookies=self._cookies() if ours else None,
                    timeout=self._timeout,
                    follow_redirects=follow,
                    max_redirects=6,
                ) as client:
                    response = client.get(url)
                    if ours and self._save:
                        # __ddg9_/__ddg10_ are a 20-minute sliding window; drop them and the edge
                        # starts redirecting to ?check=1 forever.
                        self._save(_client_cookies(client, self.base_url))
            except httpx.TooManyRedirects:
                if attempt == 0 and self._refresh and self._refresh():
                    continue
                raise ChallengeRequired("a DDoS-Guard átirányítási hurokba futott")
            if not is_challenge(response):
                return response
            if attempt == 0 and self._refresh and self._refresh():
                continue
            raise ChallengeRequired("a DDoS-Guard ellenőrzés nem engedett át")
        raise ChallengeRequired("a DDoS-Guard ellenőrzés nem engedett át")

    # -- API -------------------------------------------------------------

    def search(self, query: str, page: int = 1) -> list[Result]:
        params = {"q": query, "lang": "hu"}
        if page > 1:
            params["page"] = str(page)
        response = self._get("/search?" + str(httpx.QueryParams(params)))
        return parse_search(response.text)

    def details(self, md5: str) -> Details:
        return parse_details(self._get(f"/md5/{md5}").text)

    def download(self, md5: str, dest: Path, *, wait: bool = True) -> str:
        """Fetch the file and return its filename. Raises SourceUnavailable when there is no copy."""
        slots = parse_download_slots(self._get(f"/md5/{md5}").text, md5)
        if not slots:
            raise SourceUnavailable("nincs letölthető példány")
        for slot in slots[:4]:
            try:
                partner = self._partner_url(slot, wait=wait)
                if not partner:
                    continue
                response = self._get(partner)
            except (httpx.HTTPError, ChallengeRequired):
                continue
            if response.status_code == 200 and response.content:
                dest.write_bytes(response.content)
                return dest.name
        raise SourceUnavailable("a partnerek egyike sem adta át a fájlt")

    def _partner_url(self, slot: str, *, wait: bool) -> str:
        response = self._get(slot)
        seconds, partner = parse_slow_page(response.text)
        if partner:
            return partner
        if not wait:
            return ""
        if seconds:
            time.sleep(seconds + 2)
            response = self._get(slot)
            _, partner = parse_slow_page(response.text)
        return partner


def _client_cookies(client: httpx.Client, base_url: str) -> dict[str, str]:
    host = base_url.split("://", 1)[-1].split("/", 1)[0]
    return {
        cookie.name: cookie.value
        for cookie in client.cookies.jar
        if host in (cookie.domain or "").lstrip(".")
    }


def is_challenge(response: httpx.Response) -> bool:
    if response.status_code == 502 and len(response.content) < 2000:
        return True
    if response.status_code not in (403, 503):
        return False
    head = response.text[:4000]
    return "DDoS-Guard" in head or "data-ddg-origin" in head