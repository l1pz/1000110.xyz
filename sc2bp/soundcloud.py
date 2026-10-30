"""Reads a SoundCloud playlist with yt-dlp. No SoundCloud API key is needed (app registration requires Artist Pro).

Two steps, because a flat listing has only track links and no titles, and resolving every track in one go takes about a
second each: `list_playlist` gives the links (a few seconds), then `read_tracks` resolves a small batch at a time."""

import json
import logging
import re
import subprocess
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlparse

log = logging.getLogger("sc2bp.soundcloud")

HOSTS = {"soundcloud.com", "www.soundcloud.com", "m.soundcloud.com", "on.soundcloud.com"}
# a playlist listing points most tracks at the API (`/tracks/<id>`), not at their page
API_HOSTS = {"api.soundcloud.com", "api-v2.soundcloud.com"}
API_TRACK = re.compile(r"/tracks/\d+")
LIST_TIMEOUT_SECS = 120
MAX_TRACKS = 1000
WORKERS = 6


class PlaylistError(Exception):
    """The playlist could not be read. `retryable`: trying again later may work (a timeout)."""

    def __init__(self, message: str, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


class BadUrl(PlaylistError):
    """The address is not a SoundCloud link."""


def check_url(url: str) -> str:
    """The URL if it is an https SoundCloud link; anything else is refused so the server never fetches other hosts."""
    url = url.strip()
    try:
        parts = urlparse(url)
        host = parts.hostname
    except ValueError:
        raise BadUrl("that is not a link") from None
    if parts.scheme != "https" or host not in HOSTS:
        raise BadUrl("only https://soundcloud.com links work")
    return url


def check_track_url(url: str) -> str:
    """A track link: any SoundCloud page link, or the API's exact `/tracks/<id>` form that playlist listings use."""
    try:
        parts = urlparse(url.strip())
        if parts.scheme == "https" and parts.hostname in API_HOSTS and API_TRACK.fullmatch(parts.path) and not parts.query:
            return url.strip()
    except ValueError:
        raise BadUrl("that is not a link") from None
    return check_url(url)


def number(value: object) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def parse_listing(data: dict, url: str) -> dict:
    """yt-dlp's flat JSON as `{name, urls}`; a single track link becomes a one-track list."""
    entries = data.get("entries")
    if entries is None:
        urls = [url]
    else:
        urls = []
        for entry in entries:
            link = entry.get("url") if isinstance(entry, dict) else None
            try:
                urls.append(check_track_url(link)) if isinstance(link, str) else None
            except BadUrl:
                continue
    return {"name": str(data.get("title") or "SoundCloud playlist"), "urls": urls}


def list_playlist(url: str, run=subprocess.run) -> dict:
    command = ["yt-dlp", "--flat-playlist", "-J", "--no-warnings", "--no-cache-dir", "--", check_url(url)]
    try:
        done = run(command, capture_output=True, text=True, timeout=LIST_TIMEOUT_SECS, check=True)
        data = json.loads(done.stdout)
    except subprocess.TimeoutExpired:
        raise PlaylistError("reading the playlist took too long", retryable=True) from None
    except subprocess.CalledProcessError as error:
        log.warning("yt-dlp failed: %s", (error.stderr or "")[-500:])
        raise PlaylistError("yt-dlp could not read that playlist (private, deleted, or SoundCloud changed)") from None
    except (json.JSONDecodeError, OSError):
        raise PlaylistError("yt-dlp gave an answer I could not read") from None
    listing = parse_listing(data, url)
    if not listing["urls"]:
        raise PlaylistError("that link has no tracks")
    if len(listing["urls"]) > MAX_TRACKS:
        raise PlaylistError(f"that playlist has more than {MAX_TRACKS} tracks")
    return listing


def extract_one(url: str) -> dict:
    """One track's metadata. The `formats` argument matches nothing, which skips the per-track stream requests."""
    from yt_dlp import YoutubeDL

    options = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "cachedir": False,
        "ignore_no_formats_error": True,
        "extractor_args": {"soundcloud": {"formats": ["none"]}},
    }
    with YoutubeDL(options) as ydl:
        return ydl.extract_info(url, download=False)


def track_of(info: object) -> dict:
    """`{title, uploader, durationSec}`; blank when the track could not be read (the browser skips blanks)."""
    if not isinstance(info, dict) or not info.get("title"):
        return {"title": "", "uploader": "", "durationSec": None}
    return {
        "title": str(info["title"]),
        "uploader": str(info.get("uploader") or info.get("channel") or ""),
        "durationSec": number(info.get("duration")),
    }


def read_tracks(urls: list[str], extract: Callable[[str], dict] = extract_one, workers: int = WORKERS) -> list[dict]:
    """Metadata for each link, in the same order; a private or deleted track comes back blank."""
    checked = [check_track_url(u) for u in urls]

    def one(url: str) -> dict:
        try:
            return track_of(extract(url))
        except Exception as error:  # yt-dlp raises DownloadError and friends for private or deleted tracks
            log.warning("could not read %s: %s", url, str(error)[-200:])
            return track_of(None)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(one, checked))
