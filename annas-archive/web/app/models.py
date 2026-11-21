"""Plain data shapes shared by the sources, the queue and the templates."""

from __future__ import annotations

import re
from dataclasses import dataclass

# The order the wife asked for: a readable format first, scans last.
FORMAT_ORDER = {"EPUB": 0, "AZW3": 1, "MOBI": 2, "PDF": 3}
READABLE_FORMATS = ("EPUB", "AZW3", "MOBI")


def format_rank(fmt: str) -> int:
    return FORMAT_ORDER.get((fmt or "").upper(), 9)


def size_text(size: int | None) -> str:
    if not size:
        return ""
    value = float(size)
    for unit in ("B", "kB", "MB", "GB"):
        if value < 1024 or unit == "GB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return ""


def extension_of(fmt: str, path: str = "") -> str:
    if fmt:
        return fmt.lower()
    match = re.search(r"\.([a-z0-9]{2,5})$", path or "", re.I)
    return match.group(1).lower() if match else "epub"


@dataclass
class Result:
    """One row of a search result, from either source."""

    title: str
    author: str = ""
    year: int | None = None
    language: str = "hu"
    format: str = ""
    size: int | None = None
    md5: str = ""
    source: str = "annas"
    original_path: str = ""
    publisher: str = ""

    @property
    def extension(self) -> str:
        return extension_of(self.format, self.original_path)

    @property
    def size_text(self) -> str:
        return size_text(self.size)


@dataclass
class Book:
    """A queue entry. `status` is one of queued, downloading, ready, sent, failed."""

    id: str
    title: str
    author: str = ""
    year: int | None = None
    format: str = ""
    size: int | None = None
    md5: str = ""
    source: str = "annas"
    status: str = "queued"
    error: str = ""
    filename: str = ""
    file_path: str = ""
    created_at: float = 0.0
    updated_at: float = 0.0

    @property
    def extension(self) -> str:
        return extension_of(self.format, self.filename)

    @property
    def size_text(self) -> str:
        return size_text(self.size)