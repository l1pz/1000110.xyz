"""SQLite storage: the download queue, the DDoS-Guard cookies, and the e-reader token.

One connection per call (WAL + a short timeout) keeps this safe to use from the request handlers and
the single background worker without a lock. There is no ORM: the schema is four small tables.
"""

from __future__ import annotations

import sqlite3
import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from .models import Book

SCHEMA = """
CREATE TABLE IF NOT EXISTS books (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    author      TEXT NOT NULL DEFAULT '',
    year        INTEGER,
    format      TEXT NOT NULL DEFAULT '',
    size        INTEGER,
    md5         TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL DEFAULT 'annas',
    status      TEXT NOT NULL DEFAULT 'queued',
    error       TEXT NOT NULL DEFAULT '',
    filename    TEXT NOT NULL DEFAULT '',
    file_path   TEXT NOT NULL DEFAULT '',
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS books_status ON books (status, created_at);

CREATE TABLE IF NOT EXISTS cookies (
    name  TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
    token      TEXT PRIMARY KEY,
    name       TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL,
    last_seen  REAL NOT NULL
);
"""

BOOK_COLUMNS = (
    "id", "title", "author", "year", "format", "size", "md5", "source",
    "status", "error", "filename", "file_path", "created_at", "updated_at",
)


class Store:
    def __init__(self, path: Path):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.executescript(SCHEMA)

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA busy_timeout=10000")
            yield db
            db.commit()
        finally:
            db.close()

    # -- cookies ---------------------------------------------------------

    def cookies(self) -> dict[str, str]:
        with self._connect() as db:
            return {row["name"]: row["value"] for row in db.execute("SELECT name, value FROM cookies")}

    def set_cookies(self, values: dict[str, str]) -> None:
        with self._connect() as db:
            db.executemany(
                "INSERT INTO cookies (name, value) VALUES (?, ?) "
                "ON CONFLICT(name) DO UPDATE SET value = excluded.value",
                list(values.items()),
            )

    def clear_cookies(self) -> None:
        with self._connect() as db:
            db.execute("DELETE FROM cookies")

    # -- queue -----------------------------------------------------------

    def add_book(self, **fields) -> Book:
        now = time.time()
        fields.setdefault("id", uuid.uuid4().hex[:12])
        fields.setdefault("status", "queued")
        fields["created_at"] = now
        fields["updated_at"] = now
        columns = [c for c in BOOK_COLUMNS if c in fields]
        with self._connect() as db:
            db.execute(
                f"INSERT INTO books ({', '.join(columns)}) VALUES ({', '.join('?' * len(columns))})",
                [fields[c] for c in columns],
            )
        book = self.get_book(fields["id"])
        assert book is not None
        return book

    def get_book(self, book_id: str) -> Book | None:
        with self._connect() as db:
            row = db.execute("SELECT * FROM books WHERE id = ?", (book_id,)).fetchone()
        return _book(row) if row else None

    def find_book(self, md5: str) -> Book | None:
        with self._connect() as db:
            row = db.execute(
                "SELECT * FROM books WHERE md5 = ? AND md5 != '' ORDER BY created_at DESC LIMIT 1", (md5,)
            ).fetchone()
        return _book(row) if row else None

    def list_books(self, limit: int = 50, statuses: tuple[str, ...] | None = None) -> list[Book]:
        sql = "SELECT * FROM books"
        params: list = []
        if statuses:
            sql += f" WHERE status IN ({', '.join('?' * len(statuses))})"
            params.extend(statuses)
        sql += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        with self._connect() as db:
            return [_book(row) for row in db.execute(sql, params)]

    def ready_books(self, limit: int = 20) -> list[Book]:
        return self.list_books(limit=limit, statuses=("ready",))

    def claim_next(self) -> Book | None:
        """Atomically take one queued book; None when the queue is empty."""
        now = time.time()
        with self._connect() as db:
            row = db.execute(
                "UPDATE books SET status = 'downloading', updated_at = ? "
                "WHERE id = (SELECT id FROM books WHERE status = 'queued' ORDER BY created_at LIMIT 1) "
                "RETURNING *",
                (now,),
            ).fetchone()
        return _book(row) if row else None

    def update_book(self, book_id: str, **fields) -> None:
        allowed = {c for c in BOOK_COLUMNS if c not in {"id", "created_at"}}
        fields = {k: v for k, v in fields.items() if k in allowed}
        if not fields:
            return
        fields["updated_at"] = time.time()
        assignments = ", ".join(f"{key} = ?" for key in fields)
        with self._connect() as db:
            db.execute(f"UPDATE books SET {assignments} WHERE id = ?", [*fields.values(), book_id])

    def reset_stuck(self) -> int:
        """After a restart nothing is downloading any more; put those books back in the queue."""
        with self._connect() as db:
            cursor = db.execute(
                "UPDATE books SET status = 'queued', updated_at = ? WHERE status = 'downloading'",
                (time.time(),),
            )
            return cursor.rowcount

    def delete_book(self, book_id: str) -> None:
        with self._connect() as db:
            db.execute("DELETE FROM books WHERE id = ?", (book_id,))

    # -- devices ---------------------------------------------------------

    def touch_device(self, token: str, name: str = "") -> bool:
        """True when the token is the configured one (or was registered); False otherwise."""
        if not token:
            return False
        now = time.time()
        with self._connect() as db:
            row = db.execute("SELECT token FROM devices WHERE token = ?", (token,)).fetchone()
            if row:
                db.execute("UPDATE devices SET last_seen = ? WHERE token = ?", (now, token))
                return True
            if name:
                db.execute(
                    "INSERT INTO devices (token, name, created_at, last_seen) VALUES (?, ?, ?, ?)",
                    (token, name, now, now),
                )
                return True
        return False


def _book(row: sqlite3.Row) -> Book:
    return Book(**{key: row[key] for key in BOOK_COLUMNS})