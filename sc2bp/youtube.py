"""Reads a YouTube or YouTube Music playlist with yt-dlp.

Unlike SoundCloud, the flat listing already carries each track's title, channel and length, so one call is the whole
read: `list_playlist` returns `tracks` next to `urls` and the job skips its reading phase. A reading pass per video
would add nothing (no `artist` or `track` fields for plain uploads) and cost one YouTube request per track.

Private playlists and "Liked music" need a login: if `/data/youtube-cookies.txt` exists it is passed to yt-dlp."""

import json
import logging
import os
import re
import subprocess
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from errors import BadUrl, PlaylistError

log = logging.getLogger("sc2bp.youtube")

HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}
LIST_ID = re.compile(r"[A-Za-z0-9_-]{2,64}")
LIST_TIMEOUT_SECS = 180
MAX_TRACKS = 2000
UNAVAILABLE = {"[private video]", "[deleted video]"}
TOPIC_SUFFIX = re.compile(r"\s+-\s+Topic$", re.IGNORECASE)
CHANNEL_SUFFIX = re.compile(r"(?:\s*VEVO|\s+Official|\s+Oficial)$", re.IGNORECASE)


def cookies_path() -> Path:
    return Path(os.environ.get("SC2BP_DATA", "/data")) / "youtube-cookies.txt"


def check_url(url: str) -> str:
    """The canonical playlist address (`https://www.youtube.com/playlist?list=<id>`) for any YouTube, YouTube Music or
    youtu.be link that names a playlist. One shape means the server fetches one kind of URL, and the music. and www.
    forms of a playlist are the same job."""
    url = url.strip()
    try:
        parts = urlparse(url)
        host = parts.hostname
    except ValueError:
        raise BadUrl("that is not a link") from None
    if parts.scheme != "https" or host not in HOSTS:
        raise BadUrl("only https://youtube.com or https://music.youtube.com links work")
    ids = parse_qs(parts.query).get("list", [])
    if len(ids) != 1 or not LIST_ID.fullmatch(ids[0]):
        raise BadUrl("that link has no playlist in it (a playlist link has `list=` in it)")
    return f"https://www.youtube.com/playlist?list={ids[0]}"


def check_track_url(url: str) -> str:
    """A video link as the listing gives it (`watch?v=<id>`) on one of the YouTube hosts."""
    try:
        parts = urlparse(url.strip())
        if parts.scheme == "https" and parts.hostname in HOSTS:
            return url.strip()
    except ValueError:
        pass
    raise BadUrl("that is not a YouTube link")


def number(value: object) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0 else None


def track_of(entry: dict) -> dict:
    """`{title, uploader, durationSec, uploaderIsArtist}`. Blank for a private, deleted or title-less entry.
    A `Name - Topic` channel is YouTube Music's own upload and `Name` is the artist, so the scoring may trust it."""
    title = str(entry.get("title") or "").strip()
    if not title or title.lower() in UNAVAILABLE:
        return {"title": "", "uploader": "", "durationSec": None, "uploaderIsArtist": False}
    channel = str(entry.get("channel") or entry.get("uploader") or "").strip()
    topic = bool(TOPIC_SUFFIX.search(channel))
    channel = TOPIC_SUFFIX.sub("", channel)
    channel = CHANNEL_SUFFIX.sub("", channel).strip() or channel
    return {"title": title, "uploader": channel, "durationSec": number(entry.get("duration")), "uploaderIsArtist": topic}


def parse_listing(data: dict, url: str) -> dict:
    """yt-dlp's flat JSON as `{name, urls, tracks}`, same order in `urls` and `tracks`."""
    urls: list[str] = []
    tracks: list[dict] = []
    for entry in data.get("entries") or []:
        link = entry.get("url") if isinstance(entry, dict) else None
        if not isinstance(link, str):
            continue
        try:
            urls.append(check_track_url(link))
        except BadUrl:
            continue
        tracks.append(track_of(entry))
    return {"name": str(data.get("title") or "YouTube playlist"), "urls": urls, "tracks": tracks}


def explain_failure(stderr: str) -> PlaylistError:
    text = (stderr or "").lower()
    if "sign in to confirm" in text or "not a bot" in text:
        return PlaylistError("YouTube is asking this server to prove it is not a bot; try again later", retryable=True)
    if "private" in text or "sign in" in text or "log in" in text or "does not exist" in text or "unavailable" in text:
        return PlaylistError(
            "that playlist is private or gone; for a private one the YouTube cookies on the server may be missing or "
            "expired (see the README)"
        )
    return PlaylistError("yt-dlp could not read that playlist (private, deleted, or YouTube changed)")


def list_playlist(url: str, run=subprocess.run) -> dict:
    command = ["yt-dlp", "--flat-playlist", "-J", "--no-warnings", "--no-cache-dir"]
    cookies = cookies_path()
    if cookies.is_file():
        command += ["--cookies", str(cookies)]
    command += ["--", check_url(url)]
    try:
        done = run(command, capture_output=True, text=True, timeout=LIST_TIMEOUT_SECS, check=True)
        data = json.loads(done.stdout)
    except subprocess.TimeoutExpired:
        raise PlaylistError("reading the playlist took too long", retryable=True) from None
    except subprocess.CalledProcessError as error:
        log.warning("yt-dlp failed: %s", (error.stderr or "")[-500:])
        raise explain_failure(error.stderr) from None
    except (json.JSONDecodeError, OSError):
        raise PlaylistError("yt-dlp gave an answer I could not read") from None
    listing = parse_listing(data, url)
    if not listing["urls"]:
        raise PlaylistError("that link has no tracks")
    if len(listing["urls"]) > MAX_TRACKS:
        raise PlaylistError(f"that playlist has more than {MAX_TRACKS} tracks")
    return listing


def read_tracks(urls: list[str]) -> list[dict]:
    """Not used: `list_playlist` already read every track, so no YouTube track is ever left to read."""
    return [{"title": "", "uploader": "", "durationSec": None} for _ in urls]
