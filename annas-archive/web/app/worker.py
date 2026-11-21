"""The one background worker: takes a queued book, fetches it, leaves a file for the e-reader.

Order of attack: Anna's Archive by md5 (best metadata), then Libgen by title. A book that neither
source can serve fails with a Hungarian reason instead of retrying forever.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from pathlib import Path

from . import harvest
from .config import Config
from .models import Book
from .sources.annas import AnnaSource, ChallengeRequired, SourceUnavailable
from .sources.libgen import LibgenSource, find_match
from .store import Store

log = logging.getLogger("books.worker")

BAD_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')
SPACES = re.compile(r"\s+")
CLEANUP_EVERY = 300  # idle loops, so roughly every ten minutes


def safe_filename(title: str, author: str, extension: str) -> str:
    stem = f"{title} - {author}" if author else title
    stem = SPACES.sub(" ", BAD_CHARS.sub(" ", stem or "könyv")).strip(" .")
    return f"{stem[:120]}.{extension or 'epub'}"


class Worker:
    def __init__(self, config: Config, store: Store):
        self.config = config
        self.store = store
        self.annas = AnnaSource(
            config.annas_base,
            cookies=store.cookies,
            refresh=self._mint_clearance,
            save=store.set_cookies,
        )
        self.libgen = LibgenSource(config.libgen_base)

    def _mint_clearance(self) -> bool:
        log.warning("DDoS-Guard challenged us; minting a clearance cookie with the browser")
        ok = harvest.mint(self.config.annas_base, self.store.set_cookies)
        log.warning("clearance mint %s", "ok" if ok else "failed")
        return ok

    # -- one book --------------------------------------------------------

    def process(self, book: Book) -> None:
        started = time.time()
        try:
            filename, path = self._fetch(book)
        except Exception as error:  # noqa: BLE001 - the reason goes to the phone
            log.exception("book %s failed", book.id)
            self.store.update_book(book.id, status="failed", error=_reason(error))
            return
        self.store.update_book(book.id, status="ready", filename=filename, file_path=str(path))
        log.info("book %s ready in %.0fs: %s", book.id, time.time() - started, filename)

    def _fetch(self, book: Book) -> tuple[str, Path]:
        errors: list[str] = []
        if book.md5:
            try:
                details = self.annas.details(book.md5)
                extension = (details.format or book.format or "epub").lower()
                filename = safe_filename(book.title or details.title, book.author or details.author, extension)
                dest = self.config.files_dir / f"{book.id}.{extension}"
                self.annas.download(book.md5, dest, wait=True)
                return filename, dest
            except Exception as error:  # noqa: BLE001 - try the fallback
                errors.append(f"annas: {error}")
                log.warning("annas failed for %s: %s", book.id, error)

        try:
            return self._download_libgen(book)
        except Exception as error:  # noqa: BLE001
            errors.append(f"libgen: {error}")

        if any(error.startswith("annas: ") and "DDoS" in error for error in errors):
            raise ChallengeRequired()
        raise SourceUnavailable("; ".join(errors) or "nem található letölthető példány")

    def _download_libgen(self, book: Book) -> tuple[str, Path]:
        query = f"{book.title} {book.author}".strip()
        match = find_match(self.libgen.search(query), book.title, book.author)
        if match is None:
            raise SourceUnavailable("a Libgen nem találta a könyvet")
        extension = (match.format or book.format or "epub").lower()
        filename = safe_filename(book.title, book.author, extension)
        dest = self.config.files_dir / f"{book.id}.{extension}"
        self.libgen.download(match.md5, dest)
        return filename, dest

    # -- housekeeping ----------------------------------------------------

    def cleanup(self) -> int:
        """Delete files the e-reader already took (and anything past the TTL)."""
        deadline = time.time() - self.config.file_ttl_days * 86400
        removed = 0
        for book in self.store.list_books(limit=500, statuses=("sent", "failed")):
            path = Path(book.file_path) if book.file_path else None
            if path and path.exists() and (book.status == "sent" or book.updated_at < deadline):
                path.unlink(missing_ok=True)
                self.store.update_book(book.id, file_path="")
                removed += 1
        return removed


def _reason(error: Exception) -> str:
    if isinstance(error, ChallengeRequired):
        return "Az Anna's Archive (DDoS-Guard) most nem engedett be, a Libgen sem adta át a fájlt."
    if isinstance(error, SourceUnavailable):
        return f"Nem sikerült letölteni: {error}"
    return f"Váratlan hiba: {type(error).__name__}"


async def run(config: Config, store: Store) -> None:
    worker = Worker(config, store)
    store.reset_stuck()
    log.info("worker started; queued: %d", len(store.list_books(statuses=("queued",))))
    idle = 0
    while True:
        book = store.claim_next()
        if book is None:
            idle += 1
            if idle % CLEANUP_EVERY == 0:
                await asyncio.to_thread(worker.cleanup)
            await asyncio.sleep(2)
            continue
        idle = 0
        await asyncio.to_thread(worker.process, book)