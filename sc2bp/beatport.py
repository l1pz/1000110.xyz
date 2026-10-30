"""Beatport client, by the unofficial route: Beatport has no public API, so this borrows the public `client_id` from
the v4 docs page and logs in as the owner (the same flow as the beets-beatport4 plugin). It can break whenever Beatport
changes that page or the flow; see README.md."""

import json
import logging
import os
import re
import threading
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import httpx

log = logging.getLogger("sc2bp.beatport")
# httpx logs every request URL at INFO, which would put the one-time authorization code in the log
logging.getLogger("httpx").setLevel(logging.WARNING)

API = "https://api.beatport.com/v4"
REDIRECT_URI = f"{API}/auth/o/post-message/"
SCRIPT_SRC = re.compile(r"""src=["']([^"']+\.js)""")
CLIENT_ID = re.compile(r"API_CLIENT_ID: '(.*)'")
EXPIRY_SLACK_SECS = 30
MIN_GAP_SECS = 0.4
ADD_BATCH = 50
PLAYLIST_URL = "https://www.beatport.com/library/playlists/"


class BeatportError(Exception):
    """Beatport refused, changed, or could not be reached. The message is safe to show the owner.

    `retryable`: worth trying again later (rate limit, server error, no connection); `retry_after` is Beatport's wait
    in seconds, when it said. `fatal`: nothing will work until the owner acts (login refused, not configured)."""

    def __init__(self, message: str, retryable: bool = False, retry_after: float | None = None, fatal: bool = False):
        super().__init__(message)
        self.retryable = retryable
        self.retry_after = retry_after
        self.fatal = fatal


def retry_after(response: httpx.Response) -> float | None:
    """Seconds Beatport asked us to wait (the `Retry-After` header), or None."""
    try:
        return max(0.0, float(response.headers.get("retry-after", "")))
    except ValueError:
        return None


def candidate(track: dict) -> dict:
    """A Beatport track as the browser's `Candidate`: id, title, mix, artists, durationSec."""
    ms = track.get("length_ms")
    return {
        "id": int(track["id"]),
        "title": str(track.get("name") or ""),
        "mix": str(track.get("mix_name") or ""),
        "artists": [str(a["name"]) for a in track.get("artists") or [] if isinstance(a, dict) and "name" in a],
        "durationSec": round(ms / 1000) if isinstance(ms, (int, float)) and ms > 0 else None,
    }


class Beatport:
    def __init__(
        self,
        username: str,
        password: str,
        token_path: Path,
        transport: httpx.BaseTransport | None = None,
        sleep=time.sleep,
        clock=time.time,
    ) -> None:
        self._username = username
        self._password = password
        self._token_path = token_path
        self._transport = transport
        self._sleep = sleep
        self._clock = clock
        self._lock = threading.Lock()
        self._token: dict | None = None
        self._last_call = 0.0

    def _new_client(self) -> httpx.Client:
        return httpx.Client(transport=self._transport, timeout=30)

    # --- auth -------------------------------------------------------------------------------------------------

    def _fetch_client_id(self, http: httpx.Client) -> str:
        page = http.get(f"{API}/docs/").text
        for src in SCRIPT_SRC.findall(page):
            found = CLIENT_ID.findall(http.get(f"https://api.beatport.com{src}").text)
            if found:
                return found[0]
        raise BeatportError("could not find Beatport's public client id (the docs page changed?)", fatal=True)

    def _store(self, data: dict, client_id: str) -> dict:
        try:
            token = {
                "access_token": str(data["access_token"]),
                "refresh_token": str(data["refresh_token"]),
                "expires_at": self._clock() + int(data["expires_in"]) - EXPIRY_SLACK_SECS,
                "client_id": client_id,
            }
        except (KeyError, TypeError, ValueError):
            raise BeatportError("Beatport's token answer had an unexpected shape") from None
        try:
            self._token_path.parent.mkdir(parents=True, exist_ok=True)
            self._token_path.write_text(json.dumps(token))
            os.chmod(self._token_path, 0o600)
        except OSError:
            log.warning("could not save the token; the next call logs in again")
        return token

    def _full_flow(self) -> dict:
        log.info("logging in to Beatport")
        try:
            with self._new_client() as http:
                client_id = self._fetch_client_id(http)
            with self._new_client() as http:  # its own cookie jar: the session cookies stay out of API calls
                login = http.post(f"{API}/auth/login/", json={"username": self._username, "password": self._password})
                login.raise_for_status()
                if "username" not in login.json():
                    raise BeatportError("Beatport refused the login (wrong username or password?)", fatal=True)
                authorize = http.get(
                    f"{API}/auth/o/authorize/",
                    params={"response_type": "code", "client_id": client_id, "redirect_uri": REDIRECT_URI},
                    follow_redirects=False,
                )
                codes = parse_qs(urlparse(authorize.headers.get("location", "")).query).get("code")
                if not codes:
                    raise BeatportError("Beatport gave no authorization code (the login flow changed?)", fatal=True)
                answer = http.post(
                    f"{API}/auth/o/token/",
                    params={
                        "code": codes[0],
                        "grant_type": "authorization_code",
                        "redirect_uri": REDIRECT_URI,
                        "client_id": client_id,
                    },
                )
                answer.raise_for_status()
                return self._store(answer.json(), client_id)
        except httpx.HTTPStatusError as error:
            status = error.response.status_code
            raise BeatportError(
                f"Beatport login failed with HTTP {status}", retryable=status == 429 or status >= 500, fatal=status < 500
            ) from None
        except httpx.HTTPError:
            raise BeatportError("could not reach Beatport to log in", retryable=True) from None
        except ValueError:
            raise BeatportError("Beatport's login answer was not JSON") from None

    def _refresh(self, token: dict) -> dict:
        log.info("refreshing the Beatport token")
        try:
            with self._new_client() as http:
                answer = http.post(
                    f"{API}/auth/o/token/",
                    params={
                        "grant_type": "refresh_token",
                        "refresh_token": token["refresh_token"],
                        "client_id": token["client_id"],
                    },
                )
                answer.raise_for_status()
                return self._store(answer.json(), token["client_id"])
        except (httpx.HTTPError, ValueError, BeatportError):
            return self._full_flow()

    def _load(self) -> dict | None:
        try:
            token = json.loads(self._token_path.read_text())
        except (OSError, ValueError):
            return None
        needed = {"access_token", "refresh_token", "expires_at", "client_id"}
        return token if isinstance(token, dict) and needed <= token.keys() else None

    def _bearer(self, force: bool = False) -> str:
        if force:
            self._token = self._full_flow()
        else:
            self._token = self._token or self._load()
            if self._token is None:
                self._token = self._full_flow()
            elif self._clock() >= self._token["expires_at"]:
                self._token = self._refresh(self._token)
        return self._token["access_token"]

    # --- calls ------------------------------------------------------------------------------------------------

    def _request(self, method: str, path: str, **kwargs) -> dict:
        """One authenticated call, one polite pause before it, one re-login if the token is refused."""
        with self._lock:
            for attempt in (0, 1):
                gap = MIN_GAP_SECS - (self._clock() - self._last_call)
                if gap > 0:
                    self._sleep(gap)
                self._last_call = self._clock()
                headers = {"Authorization": f"Bearer {self._bearer(force=attempt == 1)}"}
                try:
                    with self._new_client() as http:
                        response = http.request(method, f"{API}{path}", headers=headers, follow_redirects=True, **kwargs)
                except httpx.HTTPError:
                    raise BeatportError("could not reach Beatport", retryable=True) from None
                if response.status_code == 401 and attempt == 0:
                    continue
                if response.status_code >= 400:
                    status = response.status_code
                    log.warning("%s %s answered %s: %s", method, path, status, response.text[:300])
                    raise BeatportError(
                        f"Beatport answered {status} for {method} {path}",
                        retryable=status == 429 or status >= 500,
                        retry_after=retry_after(response),
                        fatal=status in (401, 403),
                    )
                try:
                    return response.json()
                except ValueError:
                    raise BeatportError("Beatport's answer was not JSON") from None
        raise BeatportError("Beatport refused the login token")  # unreachable; keeps the type checker calm

    def search(self, query: str) -> list[dict]:
        data = self._request("GET", "/catalog/search/", params={"q": query, "per_page": 10, "type": "tracks"})
        return [candidate(t) for t in data.get("tracks") or [] if isinstance(t, dict) and "id" in t]

    def create_playlist(self, name: str) -> dict:
        """An empty playlist: `{id, url}`."""
        playlist = self._request("POST", "/my/playlists/", json={"name": name})
        playlist_id = playlist.get("id")
        if not isinstance(playlist_id, int):
            raise BeatportError("Beatport created a playlist but did not say which one")
        return {"id": playlist_id, "url": f"{PLAYLIST_URL}{playlist_id}"}

    def add_tracks(self, playlist_id: int, ids: list[int]) -> list[int]:
        """Adds up to `ADD_BATCH` tracks; returns the ids Beatport took. A track it lists as not available (for this
        account or region) is left out of the answer."""
        if len(ids) > ADD_BATCH:
            raise ValueError(f"add at most {ADD_BATCH} tracks at a time")
        items = self._request("POST", f"/my/playlists/{playlist_id}/tracks/bulk/", json={"track_ids": ids}).get("items")
        if items is None:
            return list(ids)
        return [i["track_id"] for i in items if isinstance(i, dict) and i.get("track_available", True) and "track_id" in i]
