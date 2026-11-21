"""Settings for the books service, read once from the environment.

Everything the app cannot guess (OIDC client, session secret, device token) comes from `.env` on the
server; see `.env.example`. The defaults are for a local run against the real sites.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

# A plain desktop Chrome UA. This is not cosmetic: annas-archive answers a cookieless request with a
# DDoS-Guard challenge, and the challenge decides from `navigator.userAgent` alone. `HeadlessChrome`
# in the string is an instant fail; this exact value passed the gate in the 2026-11-21 spike.
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/159.0.8154.6 Safari/537.36"
)
BROWSER_HEADERS = {
    "User-Agent": BROWSER_UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8",
}


def _bool(value: str | None, default: bool = False) -> bool:
    if value is None or value == "":
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Config:
    data_dir: Path = field(default_factory=lambda: Path(os.environ.get("DATA_DIR", "./data")))
    public_url: str = field(default_factory=lambda: os.environ.get("PUBLIC_URL", "http://localhost:8000"))
    annas_base: str = field(default_factory=lambda: os.environ.get("ANNAS_BASE_URL", "https://annas-archive.gd"))
    libgen_base: str = field(default_factory=lambda: os.environ.get("LIBGEN_BASE_URL", "https://libgen.li"))

    oidc_issuer: str = field(default_factory=lambda: os.environ.get("OIDC_ISSUER", ""))
    oidc_client_id: str = field(default_factory=lambda: os.environ.get("OIDC_CLIENT_ID", ""))
    oidc_client_secret: str = field(default_factory=lambda: os.environ.get("OIDC_CLIENT_SECRET", ""))
    allowed_group: str = field(default_factory=lambda: os.environ.get("ALLOWED_GROUP", "books"))
    session_secret: str = field(default_factory=lambda: os.environ.get("SESSION_SECRET", ""))
    sync_token: str = field(default_factory=lambda: os.environ.get("SYNC_TOKEN", ""))

    max_upload_mb: int = field(default_factory=lambda: int(os.environ.get("MAX_UPLOAD_MB", "100")))
    file_ttl_days: int = field(default_factory=lambda: int(os.environ.get("FILE_TTL_DAYS", "7")))
    # A book that is not picked up by the e-reader is dropped after this many days.
    auth_required: bool = field(default_factory=lambda: _bool(os.environ.get("AUTH_REQUIRED"), True))
    worker_enabled: bool = field(default_factory=lambda: _bool(os.environ.get("WORKER_ENABLED"), True))

    @property
    def db_path(self) -> Path:
        return self.data_dir / "books.db"

    @property
    def files_dir(self) -> Path:
        return self.data_dir / "files"

    @property
    def oidc_configured(self) -> bool:
        return bool(self.oidc_issuer and self.oidc_client_id and self.oidc_client_secret and self.session_secret)

    def ensure_dirs(self) -> None:
        self.files_dir.mkdir(parents=True, exist_ok=True)


def load() -> Config:
    return Config()