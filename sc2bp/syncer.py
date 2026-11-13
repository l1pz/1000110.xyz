"""The liked-music sync: keeps a YouTube playlist (the owner's "Liked music") filed into Beatport playlists grouped by
genre, nightly and on a button.

Rules that make it safe to leave alone:
- It only ever adds. Nothing is removed from Beatport; an unliked song stays; a track the owner deletes from a playlist
  is remembered as `dismissed` and not added back.
- What is already filed is decided by reading the Beatport playlists, never by the answer of an add call (measured on
  the real conversion: that answer was wrong for dozens of tracks). After adding, the playlist is read again: present
  means filed, absent means `unavailable`.
- Every phase can run twice with the same result, so a crash, a restart or a retry just carries on.
- State is two small JSON files in `<data>/sync/`, written to a temp file and renamed; a file that cannot be read stops
  the sync instead of being overwritten.

A run is: youtube (list the likes), beatport (find the group playlists, read what is in them), plan (what is filed,
dismissed, held), match (search Beatport for new likes), preview (the first run waits for a yes), file (add to the
playlists, then verify)."""

import json
import logging
import math
import os
import re
import secrets
import shutil
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from beatport import BeatportError
from errors import BadUrl, PlaylistError
from match import match_track
from parse import label, parse_track, search_query
from resilience import retrying

log = logging.getLogger("sc2bp.sync")

OTHER = "other"
ADD_BATCH = 50
KEEP_CANDIDATES = 5
SAVE_EVERY = 5
SAVE_SECS = 2
MAX_RUNS_KEPT = 30
ACTIVE = ("queued", "running", "awaiting")
INBOX_FILTERS = ("review", "notfound", "unavailable", "skipped", "gone")
DAY = 86400
NOTFOUND_RECHECK_SECS = 14 * DAY
NOTFOUND_RECHECKS = 3
UNAVAILABLE_RECHECK_SECS = 30 * DAY
UNAVAILABLE_RECHECKS = 3
AUTO_RETRY_SECS = 6 * 3600
STALE_SECS = 36 * 3600
MAX_LIKES = 10000  # the conversion limit (2000) would stop a sync for good once the likes grow past it
SETTLE_SECS = 3  # Beatport may answer a read just after an add with the old list: look again before believing it
SUSPICIOUS_SHARE = 0.5  # fewer likes than this share of the known ones means YouTube answered wrongly
SUSPICIOUS_MIN_KNOWN = 20
TICK_SECS = 20
MAX_GROUPS = 30
RUN_ID = re.compile(r"[0-9a-f]{8}")
VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{1,32}")
GROUP_ID = re.compile(r"[a-z0-9-]{1,30}")
JOB_ID = re.compile(r"[0-9a-f]{8}")

# Beatport's own genre names, merged into families: about eight playlists for a normal collection
DEFAULT_GROUPS = [
    {
        "id": "techno",
        "name": "Techno",
        "genres": [
            "Techno (Peak Time / Driving)",
            "Techno (Raw / Deep / Hypnotic)",
            "Hard Techno",
            "Minimal / Deep Tech",
        ],
    },
    {"id": "pop-dance", "name": "Pop & Dance", "genres": ["Dance / Pop", "Pop"]},
    {
        "id": "house-melodic",
        "name": "House & Melodic",
        "genres": [
            "House",
            "Tech House",
            "Melodic House & Techno",
            "Deep House",
            "Bass House",
            "Indie Dance",
            "Indie Tech",
            "Afro House",
            "Progressive House",
            "Funky House",
            "Jackin House",
            "Organic House",
            "Nu Disco / Disco",
            "Amapiano",
            "Electro (Classic / Detroit / Modern)",
        ],
    },
    {"id": "hard-dance", "name": "Hard Dance & Mainstage", "genres": ["Hard Dance / Hardcore / Neo Rave", "Mainstage"]},
    {
        "id": "bass",
        "name": "Drum & Bass and Bass",
        "genres": [
            "Drum & Bass",
            "Dubstep",
            "Breaks / Breakbeat / UK Bass",
            "Trap / Future Bass",
            "140 / Deep Dubstep / Grime",
            "UK Garage / Bassline",
            "Bass / Club",
            "Brazilian Funk",
        ],
    },
    {"id": "rock-hiphop", "name": "Rock & Hip-Hop", "genres": ["Rock", "Hip-Hop", "Latin", "African", "R&B"]},
    {
        "id": "trance-psy",
        "name": "Trance & Psy",
        "genres": ["Trance (Main Floor)", "Trance (Raw / Deep / Hypnotic)", "Psy-Trance"],
    },
    {"id": "electronica", "name": "Electronica", "genres": ["Electronica", "Ambient / Experimental"]},
]


def default_config() -> dict:
    return {
        "source": "https://www.youtube.com/playlist?list=LM",
        "prefix": "Liked",
        "cap": 100,
        "nightly": {"enabled": False, "hour": 4, "minute": 30, "tz": "Europe/Budapest"},
        "groups": json.loads(json.dumps(DEFAULT_GROUPS)),
        "otherName": "Other",
    }


def default_state() -> dict:
    return {
        "version": 1,
        "videos": {},
        "playlists": {},
        "runs": [],
        "lastSuccess": None,
        "confirmedOnce": False,
        "lastAutoSlot": 0,
        "autoRetryAt": None,
    }


class SyncError(Exception):
    """The run cannot go on. `retryable`: trying again later may work; `kind`: `cookies` when YouTube needs a login."""

    def __init__(self, message: str, retryable: bool = False, kind: str = ""):
        super().__init__(message)
        self.retryable = retryable
        self.kind = kind


class StateError(Exception):
    """A saved file could not be read. The sync stops rather than overwrite it."""


class Cancelled(Exception):
    pass


class Awaiting(Exception):
    """The first run is waiting for the owner to look at the preview."""


def video_id(url: str) -> str | None:
    """The YouTube video id in a watch link, or None."""
    try:
        ids = parse_qs(urlparse(url).query).get("v", [])
    except ValueError:
        return None
    return ids[0] if len(ids) == 1 and VIDEO_ID.fullmatch(ids[0]) else None


def latest_slot(now: float, hour: int, minute: int, tz: str) -> float:
    """The most recent moment at `hour:minute` (local time in `tz`) that is not after `now`."""
    local = datetime.fromtimestamp(now, ZoneInfo(tz))
    slot = local.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if slot > local:
        slot -= timedelta(days=1)
    return slot.timestamp()


def write_json(path: Path, data: object) -> None:
    """Written to a temp file first, so a crash never leaves half a file."""
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def read_json(path: Path, default: dict) -> dict:
    if not path.exists():
        return json.loads(json.dumps(default))
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("not an object")
        return data
    except (OSError, ValueError) as error:
        raise StateError(f"{path.name} could not be read ({error}); it was left as it is") from None


def chunks(items: list, size: int):
    for start in range(0, len(items), size):
        yield items[start : start + size]


class Syncer:
    def __init__(self, data_dir: Path, youtube, beatport, jobs_dir: Path | None = None, sleep=time.sleep, clock=time.time):
        """`youtube` has `list_playlist(url)` and `check_url(url)`; `beatport` is a function returning a client with
        `search`, `my_playlists`, `playlist_tracks`, `tracks_by_ids`, `create_playlist` and `add_tracks`."""
        self._dir = Path(data_dir) / "sync"
        self._dir.mkdir(parents=True, exist_ok=True)
        self._jobs_dir = Path(jobs_dir) if jobs_dir else Path(data_dir) / "jobs"
        self._yt = youtube
        self._beatport = beatport
        self._sleep = sleep
        self._clock = clock
        self._lock = threading.RLock()
        self._wake = threading.Condition(self._lock)
        self._last_tick = 0.0
        self.broken: str | None = None
        self._config = default_config()
        self._state = default_state()
        self._load()

    # --- storage ----------------------------------------------------------------------------------------------

    def _load(self) -> None:
        try:
            config = read_json(self._dir / "config.json", default_config())
            state = read_json(self._dir / "state.json", default_state())
        except StateError as error:
            self.broken = str(error)
            log.error("sync stopped: %s", error)
            return
        self._config = {**default_config(), **config}
        self._config["nightly"] = {**default_config()["nightly"], **(config.get("nightly") or {})}
        self._state = {**default_state(), **state}
        for run in self._state["runs"]:
            if run["state"] == "running":  # the server stopped mid-run: carry on
                run["state"] = "queued"
            run["waiting"] = None

    def _save_state(self) -> None:
        """Caller holds the lock."""
        if self.broken:
            return
        write_json(self._dir / "state.json", self._state)

    def _save_config(self) -> None:
        if not self.broken:
            write_json(self._dir / "config.json", self._config)

    def _backup(self) -> None:
        path = self._dir / "state.json"
        if path.exists():
            shutil.copyfile(path, self._dir / "state.json.bak")

    # --- configuration ----------------------------------------------------------------------------------------

    def config(self) -> dict:
        with self._lock:
            return json.loads(json.dumps(self._config))

    def update_config(self, patch: dict) -> dict:
        """Validates a change and saves it. A group that has playlists keeps its id and name (they are in the playlist
        names); so does the prefix once any playlist exists."""
        with self._lock:
            if self.broken:
                raise SyncError(self.broken)
            new = json.loads(json.dumps(self._config))
            if "source" in patch:
                try:
                    new["source"] = self._yt.check_url(str(patch["source"]))
                except BadUrl as error:
                    raise SyncError(str(error)) from None
            if "prefix" in patch:
                prefix = str(patch["prefix"]).strip()
                if not 1 <= len(prefix) <= 40 or "#" in prefix:
                    raise SyncError("the playlist name prefix must be 1 to 40 characters, without #")
                new["prefix"] = prefix
            if "cap" in patch:
                cap = patch["cap"]
                if not isinstance(cap, int) or isinstance(cap, bool) or not 1 <= cap <= 2000:
                    raise SyncError("tracks per playlist must be a whole number from 1 to 2000")
                new["cap"] = cap
            if "nightly" in patch:
                new["nightly"] = self._check_nightly({**new["nightly"], **patch["nightly"]})
            if "groups" in patch:
                new["groups"] = self._check_groups(patch["groups"])
            if "otherName" in patch:
                other = str(patch["otherName"]).strip()
                if not 1 <= len(other) <= 40 or "#" in other:
                    raise SyncError("the name of the catch-all group must be 1 to 40 characters, without #")
                new["otherName"] = other
            self._check_locked(new)
            self._config = new
            self._save_config()
            return json.loads(json.dumps(new))

    @staticmethod
    def _check_nightly(nightly: dict) -> dict:
        enabled, hour, minute, tz = (nightly.get(k) for k in ("enabled", "hour", "minute", "tz"))
        if not isinstance(enabled, bool):
            raise SyncError("nightly must be on or off")
        if not (isinstance(hour, int) and 0 <= hour <= 23 and isinstance(minute, int) and 0 <= minute <= 59):
            raise SyncError("the nightly time must be a real hour and minute")
        try:
            ZoneInfo(str(tz))
        except (ZoneInfoNotFoundError, ValueError, OSError):
            raise SyncError(f"unknown time zone {tz!r}") from None
        return {"enabled": enabled, "hour": hour, "minute": minute, "tz": str(tz)}

    @staticmethod
    def _check_groups(groups: object) -> list[dict]:
        if not isinstance(groups, list) or not 1 <= len(groups) <= MAX_GROUPS:
            raise SyncError(f"there must be 1 to {MAX_GROUPS} groups")
        out, ids, names, seen = [], set(), set(), {}
        for g in groups:
            gid, name, genres = (g.get(k) if isinstance(g, dict) else None for k in ("id", "name", "genres"))
            if not (isinstance(gid, str) and GROUP_ID.fullmatch(gid)) or gid == OTHER:
                raise SyncError("a group id is 1 to 30 lowercase letters, digits or dashes (and not 'other')")
            if not isinstance(name, str) or not 1 <= len(name.strip()) <= 40 or "#" in name:
                raise SyncError("a group name is 1 to 40 characters, without #")
            if not isinstance(genres, list) or not all(isinstance(x, str) and 1 <= len(x) <= 80 for x in genres):
                raise SyncError("a group's genres must be a list of Beatport genre names")
            if gid in ids or name.strip().lower() in names:
                raise SyncError("group ids and names must be different from each other")
            for genre in genres:
                if genre in seen:
                    raise SyncError(f"the genre {genre!r} is in both {seen[genre]!r} and {name!r}")
                seen[genre] = name
            ids.add(gid)
            names.add(name.strip().lower())
            out.append({"id": gid, "name": name.strip(), "genres": list(dict.fromkeys(genres))})
        return out

    def _check_locked(self, new: dict) -> None:
        made = {gid for gid, entries in self._state["playlists"].items() if entries}
        if made and new["prefix"] != self._config["prefix"]:
            raise SyncError("the prefix is part of the playlist names, so it cannot change once playlists exist")
        old = {g["id"]: g["name"] for g in self._config["groups"]}
        now = {g["id"]: g["name"] for g in new["groups"]}
        for gid in made - {OTHER}:
            if gid in old and (gid not in now or now[gid] != old[gid]):
                raise SyncError(f"the group {old[gid]!r} has playlists on Beatport, so it cannot be renamed or removed")
        if OTHER in made and new["otherName"] != self._config["otherName"]:
            raise SyncError("the catch-all group has playlists on Beatport, so it cannot be renamed")

    def _groups(self) -> list[dict]:
        """The configured groups plus the catch-all, as `{id, name, genres}`."""
        return [*self._config["groups"], {"id": OTHER, "name": self._config["otherName"], "genres": []}]

    def _group_of(self, v: dict) -> str:
        ids = {g["id"] for g in self._groups()}
        if v.get("groupOverride") in ids:
            return v["groupOverride"]
        genre = v.get("genre")
        for g in self._config["groups"]:
            if genre and genre in g["genres"]:
                return g["id"]
        return OTHER

    def _playlist_name(self, gid: str, n: int) -> str:
        name = next(g["name"] for g in self._groups() if g["id"] == gid)
        return f"{self._config['prefix']} - {name} #{n}"

    # --- requests (called from the routes) --------------------------------------------------------------------

    def _active(self) -> dict | None:
        return next((r for r in reversed(self._state["runs"]) if r["state"] in ACTIVE), None)

    def start_run(self, kind: str = "manual") -> tuple[dict, bool]:
        """A new run, or the one already going. Returns `(summary, created)`."""
        with self._lock:
            if self.broken:
                raise SyncError(self.broken)
            active = self._active()
            if active:
                return self._run_view(active), False
            run = {
                "id": secrets.token_hex(4),
                "kind": kind,
                "state": "queued",
                "phase": "youtube",
                "created": self._clock(),
                "updated": self._clock(),
                "finished": None,
                "counts": {},
                "error": None,
                "waiting": None,
                "cancelRequested": False,
                "confirmed": False,
                "preview": None,
            }
            self._state["runs"].append(run)
            del self._state["runs"][:-MAX_RUNS_KEPT]
            self._backup()
            self._save_state()
            self._wake.notify_all()
            return self._run_view(run), True

    def confirm_run(self, run_id: str) -> dict:
        with self._lock:
            run = self._get_run(run_id)
            if run["state"] != "awaiting":
                raise SyncError("that run is not waiting for a decision")
            run.update(state="queued", confirmed=True, preview=None, updated=self._clock())
            self._save_state()
            self._wake.notify_all()
            return self._run_view(run)

    def cancel_run(self, run_id: str) -> dict:
        with self._lock:
            run = self._get_run(run_id)
            if run["state"] in ("queued", "awaiting"):
                self._finish(run, "cancelled")
            elif run["state"] == "running":
                run["cancelRequested"] = True
                self._save_state()
            else:
                raise SyncError("that run is already over")
            return self._run_view(run)

    def _get_run(self, run_id: str) -> dict:
        if not RUN_ID.fullmatch(run_id):
            raise KeyError(run_id)
        for run in self._state["runs"]:
            if run["id"] == run_id:
                return run
        raise KeyError(run_id)

    @staticmethod
    def _run_view(run: dict) -> dict:
        return {k: v for k, v in run.items() if k != "cancelRequested"}

    def runs(self) -> list[dict]:
        with self._lock:
            return [self._run_view(r) for r in reversed(self._state["runs"])]

    def get_run(self, run_id: str) -> dict:
        with self._lock:
            return self._run_view(self._get_run(run_id))

    def status(self) -> dict:
        """Everything the tool's home page shows."""
        with self._lock:
            videos = list(self._state["videos"].values())
            count = lambda pred: sum(1 for v in videos if pred(v))  # noqa: E731
            gone = [e for entries in self._state["playlists"].values() for e in entries if e.get("gone")]
            groups = []
            for g in self._groups():
                entries = self._state["playlists"].get(g["id"], [])
                tracks = count(lambda v, gid=g["id"]: v.get("filed") and self._group_of(v) == gid)
                if tracks or entries or g["id"] != OTHER:
                    groups.append(
                        {
                            "id": g["id"],
                            "name": g["name"],
                            "tracks": tracks,
                            "playlists": [
                                {"id": e["id"], "name": e["name"], "url": e["url"], "count": e.get("count", 0), "gone": bool(e.get("gone"))}
                                for e in entries
                            ],
                        }
                    )
            last = self._state["runs"][-1] if self._state["runs"] else None
            return {
                "config": self.config(),
                "health": self.health(),
                "run": self._run_view(self._active() or last) if (self._active() or last) else None,
                "counts": {
                    "liked": count(lambda v: v.get("liked")),
                    "onBeatport": count(lambda v: v.get("filed")),
                    "review": count(lambda v: v["status"] == "review"),
                    "notFound": count(lambda v: v["status"] == "notfound"),
                    "unavailable": count(lambda v: v["status"] == "unavailable"),
                    "skipped": count(lambda v: v["status"] == "skipped"),
                    "unreadable": count(lambda v: v["status"] == "unreadable"),
                    "dismissed": count(lambda v: v.get("dismissed")),
                    "unliked": count(lambda v: not v.get("liked") and v.get("filed")),
                    "gone": len(gone),
                    "needYou": count(lambda v: v["status"] == "review") + len(gone),
                },
                "groups": groups,
                "lastSuccess": self._state["lastSuccess"],
                "nextAuto": self._next_auto(),
                "confirmedOnce": self._state["confirmedOnce"],
            }

    def _next_auto(self) -> float | None:
        nightly = self._config["nightly"]
        if not (nightly["enabled"] and self._state["confirmedOnce"]):
            return None
        slot = latest_slot(self._clock(), nightly["hour"], nightly["minute"], nightly["tz"])
        return slot + DAY if self._state["lastAutoSlot"] >= slot else slot

    def health(self) -> dict:
        """`ok` is False when the owner has to act: cookies, a failed run, a stale sync, a broken state file."""
        with self._lock:
            if self.broken:
                return {"ok": False, "configured": True, "status": "broken", "message": self.broken}
            if not self._state["confirmedOnce"]:
                return {"ok": True, "configured": False, "status": "unconfigured", "message": "no sync has finished yet"}
            finished = [r for r in self._state["runs"] if r["state"] in ("done", "failed")]
            last = finished[-1] if finished else None
            if last and last["state"] == "failed":
                error = last.get("error") or {}
                status = "needs-cookies" if error.get("kind") == "cookies" else "failed"
                return {"ok": False, "configured": True, "status": status, "message": error.get("message") or "the last run failed"}
            nightly = self._config["nightly"]["enabled"]
            ok_since = self._state["lastSuccess"]
            if nightly and ok_since and self._clock() - ok_since > STALE_SECS:
                return {"ok": False, "configured": True, "status": "stale", "message": "no successful sync for more than 36 hours"}
            return {"ok": True, "configured": True, "status": "ok", "message": ""}

    # --- inbox and decisions ----------------------------------------------------------------------------------

    def _row(self, vid: str, v: dict) -> dict:
        parsed = parse_track(
            v["title"], v["uploader"], v["durationSec"], source="youtube", uploader_is_artist=v.get("uploaderIsArtist", False)
        )
        return {
            "id": vid,
            "url": f"https://music.youtube.com/watch?v={vid}",
            "label": label(parsed) if v["title"] else "(could not be read)",
            "title": v["title"],
            "uploader": v["uploader"],
            "durationSec": v["durationSec"],
            "status": v["status"],
            "verdict": v.get("verdict"),
            "picked": v.get("picked"),
            "genre": v.get("genre"),
            "group": self._group_of(v),
            "groupOverride": v.get("groupOverride"),
            "filed": bool(v.get("filed")),
            "dismissed": bool(v.get("dismissed")),
            "query": v.get("query") or search_query(parsed),
            "candidates": v.get("candidates", []),
            "error": v.get("error"),
            "checks": v.get("checks"),
        }

    def inbox(self, which: str = "review", offset: int = 0, limit: int = 25) -> dict:
        if which not in INBOX_FILTERS:
            raise SyncError(f"unknown filter {which!r}")
        with self._lock:
            if which == "gone":
                rows = [
                    {"group": gid, "id": e["id"], "name": e["name"], "tracks": sum(1 for v in self._state["videos"].values() if v.get("playlistId") == e["id"])}
                    for gid, entries in self._state["playlists"].items()
                    for e in entries
                    if e.get("gone")
                ]
                return {"total": len(rows), "playlists": rows[offset : offset + limit], "videos": []}
            wanted = [
                (vid, v)
                for vid, v in sorted(self._state["videos"].items(), key=lambda kv: kv[1].get("pos", 0))
                if v["status"] == which
            ]
            return {"total": len(wanted), "playlists": [], "videos": [self._row(vid, v) for vid, v in wanted[offset : offset + limit]]}

    def _video(self, vid: str) -> dict:
        if not VIDEO_ID.fullmatch(vid) or vid not in self._state["videos"]:
            raise KeyError(vid)
        return self._state["videos"][vid]

    def pick(self, vid: str, beatport_id: int | None) -> dict:
        """Choose one of the suggestions (or undo the choice). It is filed on the next run."""
        with self._lock:
            v = self._video(vid)
            if v.get("filed"):
                raise SyncError("that track is already in a Beatport playlist")
            if beatport_id is None:
                v.update(picked=None, genre=None, status="review" if v.get("verdict") == "maybe" else "notfound")
            else:
                chosen = next((c for c in v.get("candidates", []) if c["id"] == beatport_id), None)
                if chosen is None:
                    raise SyncError("that is not one of the suggestions")
                v.update(
                    picked=beatport_id,
                    genre=chosen.get("genre") or None,
                    subGenre=chosen.get("subGenre"),
                    status="matched",
                    dismissed=False,
                    held=None,
                    error=None,
                )
            self._save_state()
            return self._row(vid, v)

    def search_video(self, vid: str, query: str) -> dict:
        """Search Beatport by hand for one liked song and offer the results (nothing is picked)."""
        query = query.strip()
        if not query:
            raise SyncError("type something to search for")
        with self._lock:
            v = self._video(vid)
            if v.get("filed"):
                raise SyncError("that track is already in a Beatport playlist")
            if v["status"] == "skipped":
                raise SyncError("that track is skipped; bring it back first")
            parsed = self._parsed(v)
        found = self._beatport().search(query)  # a BeatportError goes to the route
        result = match_track(parsed, found)
        with self._lock:
            v = self._video(vid)
            v["candidates"] = self._scored(result)
            v["query"] = query
            v["picked"] = None
            v["genre"] = None
            v["status"] = "review" if v["candidates"] else "notfound"
            self._save_state()
            return self._row(vid, v)

    def skip(self, vid: str) -> dict:
        with self._lock:
            v = self._video(vid)
            if v.get("filed"):
                raise SyncError("that track is already in a Beatport playlist; remove it there if you do not want it")
            v.update(status="skipped", picked=None)
            self._save_state()
            return self._row(vid, v)

    def restore(self, vid: str) -> dict:
        """Take a skipped track back: it is searched again on the next run."""
        with self._lock:
            v = self._video(vid)
            if v["status"] != "skipped":
                raise SyncError("that track was not skipped")
            v.update(status="new", error=None, checks={"n": 0, "next": 0})
            self._save_state()
            return self._row(vid, v)

    def set_group(self, vid: str, group: str | None) -> dict:
        with self._lock:
            v = self._video(vid)
            if group is not None and group not in {g["id"] for g in self._groups()}:
                raise SyncError("unknown group")
            if v.get("filed"):
                raise SyncError("that track is already in a Beatport playlist")
            v["groupOverride"] = group
            self._save_state()
            return self._row(vid, v)

    def resolve_gone(self, playlist_id: int, action: str) -> dict:
        """A playlist the sync made is no longer on Beatport. `recreate`: its tracks are filed again, into new
        playlists. `forget`: they are left out for good (dismissed)."""
        if action not in ("recreate", "forget"):
            raise SyncError("the action is recreate or forget")
        with self._lock:
            entry = next(
                (e for entries in self._state["playlists"].values() for e in entries if e["id"] == playlist_id and e.get("gone")),
                None,
            )
            if entry is None:
                raise KeyError(playlist_id)
            for v in self._state["videos"].values():
                if v.get("playlistId") == playlist_id and v.get("held") == "gone":
                    v["held"] = None
                    v["playlistId"] = None
                    if action == "forget":
                        v["dismissed"] = True
            for gid, entries in self._state["playlists"].items():
                self._state["playlists"][gid] = [e for e in entries if e["id"] != playlist_id]
            self._save_state()
            return {"ok": True}

    def import_job(self, job_id: str) -> dict:
        """Seed the sync from a finished conversion of the same playlist: its matches (and the owner's picks) are reused,
        so the first run only has to genre and file them instead of searching every track again."""
        if not JOB_ID.fullmatch(job_id):
            raise KeyError(job_id)
        path = self._jobs_dir / f"{job_id}.json"
        try:
            job = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise KeyError(job_id) from None
        except (OSError, ValueError):
            raise SyncError("that conversion could not be read") from None
        with self._lock:
            if self.broken:
                raise SyncError(self.broken)
            try:
                same = job.get("source") == "youtube" and job.get("url") == self._yt.check_url(self._config["source"])
            except BadUrl:
                same = False
            if not same:
                raise SyncError("that conversion was of a different playlist than the one this sync follows")
            now = self._clock()
            imported = 0
            for i, t in enumerate(job.get("tracks") or []):
                vid = video_id(t.get("url", ""))
                if not vid or vid in self._state["videos"]:
                    continue
                self._state["videos"][vid] = self._imported(t, i, now)
                imported += 1
            self._save_state()
            return {"imported": imported, "total": len(job.get("tracks") or [])}

    def _imported(self, t: dict, pos: int, now: float) -> dict:
        v = self._new_video(t.get("title", ""), t.get("uploader", ""), t.get("durationSec"), bool(t.get("uploaderIsArtist")), pos, now)
        candidates = t.get("candidates") or []
        picked = t.get("picked")
        if picked is None and t.get("verdict") == "match" and candidates:
            picked = candidates[0]["id"]  # the add call "refused" it, which is not proof (see README): file it again
        if t.get("state") == "unreadable":
            v["status"] = "unreadable"
        elif t.get("state") == "matched":
            v.update(verdict=t.get("verdict"), query=t.get("query", ""), candidates=candidates)
            if picked is not None:
                v.update(status="matched", picked=picked)
                chosen = next((c for c in candidates if c["id"] == picked), {})
                v["genre"] = chosen.get("genre")
            elif t.get("verdict") == "maybe":
                v["status"] = "review"
            else:
                v.update(status="notfound", checks={"n": 1, "next": now + NOTFOUND_RECHECK_SECS})
        return v

    # --- the worker -------------------------------------------------------------------------------------------

    def run_forever(self, stop: threading.Event) -> None:
        while not stop.is_set():
            try:
                self.tick()
                run_id = self._claim(timeout=1.0)
                if run_id:
                    self._process(run_id)
            except Exception:  # the worker must outlive any bug in one pass
                log.exception("the sync worker hit an error")
                stop.wait(5)

    def process_next(self) -> str | None:
        """Run the oldest queued run to its end (or its pause); for tests and scripts."""
        run_id = self._claim(timeout=0)
        if run_id:
            self._process(run_id)
        return run_id

    def tick(self, force: bool = False) -> bool:
        """Start the nightly run when it is due. Returns whether one was started."""
        now = self._clock()
        if not force and now - self._last_tick < TICK_SECS:
            return False
        self._last_tick = now
        with self._lock:
            nightly = self._config["nightly"]
            if self.broken or not (nightly["enabled"] and self._state["confirmedOnce"]) or self._active():
                return False
            slot = latest_slot(now, nightly["hour"], nightly["minute"], nightly["tz"])
            retry = self._state["autoRetryAt"]
            if not (self._state["lastAutoSlot"] < slot or (retry and now >= retry)):
                return False
            self._state["lastAutoSlot"] = slot
            self._state["autoRetryAt"] = None
            self.start_run("auto")
            return True

    def _claim(self, timeout: float) -> str | None:
        with self._wake:
            queued = lambda: [r for r in self._state["runs"] if r["state"] == "queued"]  # noqa: E731
            if not queued() and timeout:
                self._wake.wait(timeout)
            runs = queued()
            if not runs:
                return None
            run = runs[0]
            run["state"] = "running"
            run["updated"] = self._clock()
            self._save_state()
            return run["id"]

    def _process(self, run_id: str) -> None:
        with self._lock:
            run = self._get_run(run_id)
        try:
            self._run(run)
        except Cancelled:
            self._finish(run, "cancelled")
        except Awaiting:
            with self._lock:
                run.update(state="awaiting", waiting=None, updated=self._clock())
                self._save_state()
        except SyncError as error:
            self._finish(run, "failed", str(error), error.kind, error.retryable)
        except (BeatportError, PlaylistError) as error:
            kind = "cookies" if "cookies" in str(error) else ""
            self._finish(run, "failed", str(error), kind, error.retryable)
        except Exception:
            log.exception("sync run %s crashed", run_id)
            self._finish(run, "failed", "something unexpected went wrong (the server log has the details)")

    def _finish(self, run: dict, state: str, message: str | None = None, kind: str = "", retryable: bool = False) -> None:
        with self._lock:
            now = self._clock()
            run.update(state=state, waiting=None, cancelRequested=False, finished=now, updated=now)
            run["error"] = {"message": message, "phase": run["phase"], "kind": kind, "retryable": retryable} if message else None
            if state == "done":
                self._state["lastSuccess"] = now
                self._state["autoRetryAt"] = None
                self._state["confirmedOnce"] = True
                nightly = self._config["nightly"]  # a good run of any kind is today's sync: no second one right after
                self._state["lastAutoSlot"] = max(
                    self._state["lastAutoSlot"], latest_slot(now, nightly["hour"], nightly["minute"], nightly["tz"])
                )
            elif state == "failed" and run["kind"] == "auto" and kind != "cookies":
                self._state["autoRetryAt"] = now + AUTO_RETRY_SECS
            self._save_state()
        log.info("sync run %s is %s%s", run["id"], state, f": {message}" if message else "")

    def _phase(self, run: dict, phase: str) -> None:
        with self._lock:
            run["phase"] = phase
            run["updated"] = self._clock()
            self._save_state()

    def _check(self, run: dict) -> None:
        with self._lock:
            if run["cancelRequested"]:
                raise Cancelled

    def _wait(self, run: dict, seconds: float, reason: str) -> None:
        with self._lock:
            run["waiting"] = {"until": self._clock() + seconds, "reason": reason}
            self._save_state()
        end = self._clock() + seconds
        while self._clock() < end:
            self._check(run)
            self._sleep(min(1.0, max(0.0, end - self._clock())))
        with self._lock:
            run["waiting"] = None
            self._save_state()

    def _retry(self, run: dict, call, what: str):
        return retrying(call, lambda seconds, reason: self._wait(run, seconds, reason), what, f"sync {run['id']}")

    # --- a run ------------------------------------------------------------------------------------------------

    def _run(self, run: dict) -> None:
        ctx = {"members": {}}
        run["counts"] = {"newLikes": 0, "searched": 0, "matched": 0, "added": 0, "unavailable": 0, "dismissed": 0, **(run.get("counts") or {})}
        self._phase(run, "youtube")
        self._read_youtube(run)
        self._phase(run, "beatport")
        self._read_beatport(run, ctx)
        self._phase(run, "plan")
        self._plan(run, ctx)
        self._phase(run, "match")
        self._match(run)
        with self._lock:
            pending = self._pending()
        if pending and not self._state["confirmedOnce"] and not run["confirmed"]:
            self._fill_genres(run)
            with self._lock:
                run["preview"] = self._preview(ctx)
            raise Awaiting
        self._phase(run, "file")
        self._file(run, ctx)
        self._phase(run, "finished")
        self._finish(run, "done")

    def _new_video(self, title: str, uploader: str, duration, uploader_is_artist: bool, pos: int, now: float) -> dict:
        return {
            "title": title,
            "uploader": uploader,
            "uploaderIsArtist": uploader_is_artist,
            "durationSec": duration,
            "firstSeen": now,
            "lastSeen": now,
            "pos": pos,
            "liked": True,
            "status": "new" if title else "unreadable",
            "verdict": None,
            "query": "",
            "candidates": [],
            "picked": None,
            "genre": None,
            "filed": False,
            "dismissed": False,
            "held": None,
            "checks": {"n": 0, "next": 0},
            "error": None,
        }

    def _read_youtube(self, run: dict) -> None:
        self._check(run)
        source = self._config["source"]
        try:
            listing = self._retry(
                run, lambda: self._yt.list_playlist(source, max_tracks=MAX_LIKES), "reading the YouTube playlist"
            )
        except PlaylistError as error:
            if "cookies" in str(error):
                raise SyncError(str(error), kind="cookies") from None
            raise
        entries = []
        for url, info in zip(listing["urls"], listing.get("tracks") or [], strict=False):
            vid = video_id(url)
            if vid:
                entries.append((vid, info))
        with self._lock:
            known = sum(1 for v in self._state["videos"].values() if v.get("liked"))
            if not entries:
                raise SyncError("YouTube returned no liked songs; nothing was changed", retryable=True)
            if known >= SUSPICIOUS_MIN_KNOWN and len(entries) < known * SUSPICIOUS_SHARE:
                raise SyncError(
                    f"YouTube returned {len(entries)} songs but {known} were known; it looks wrong, so nothing was changed",
                    retryable=True,
                )
            now = self._clock()
            seen = set()
            new = 0
            for pos, (vid, info) in enumerate(entries):
                seen.add(vid)
                v = self._state["videos"].get(vid)
                if v is None:
                    self._state["videos"][vid] = self._new_video(
                        info.get("title", ""), info.get("uploader", ""), info.get("durationSec"), bool(info.get("uploaderIsArtist")), pos, now
                    )
                    new += 1
                else:
                    v.update(liked=True, lastSeen=now, pos=pos)
                    if info.get("title") and not v["title"]:
                        v.update(title=info["title"], uploader=info.get("uploader", ""), durationSec=info.get("durationSec"))
                        if v["status"] == "unreadable":
                            v["status"] = "new"
            for vid, v in self._state["videos"].items():
                if vid not in seen:
                    v["liked"] = False  # unliked: it stays on Beatport (the sync never removes)
            run["counts"]["newLikes"] = new
            self._save_state()

    def _read_beatport(self, run: dict, ctx: dict) -> None:
        self._check(run)
        bp = self._beatport()
        mine = self._retry(run, lambda: bp.my_playlists(), "listing your Beatport playlists")
        by_id = {p["id"]: p for p in mine}
        with self._lock:
            for g in self._groups():
                entries = self._state["playlists"].setdefault(g["id"], [])
                pattern = re.compile(rf"{re.escape(self._config['prefix'])} - {re.escape(g['name'])} #(\d+)")
                known = {e["id"] for e in entries}
                for p in mine:  # adopt by name, so lost state is rebuilt from Beatport
                    m = pattern.fullmatch(p["name"])
                    if m and p["id"] not in known:
                        entries.append({"id": p["id"], "url": p["url"], "name": p["name"], "n": int(m.group(1)), "gone": False})
                for e in entries:
                    e["gone"] = e["id"] not in by_id
                entries.sort(key=lambda e: e["n"])
            targets = [e for entries in self._state["playlists"].values() for e in entries if not e["gone"]]
        for e in targets:
            self._check(run)
            tracks = self._retry(run, lambda pid=e["id"]: bp.playlist_tracks(pid), "reading a Beatport playlist")
            ctx["members"][e["id"]] = {t["id"]: t for t in tracks}
            with self._lock:
                e["count"] = sum(1 for t in tracks if not t.get("tombstoned"))
        with self._lock:
            self._save_state()

    def _plan(self, run: dict, ctx: dict) -> None:
        now = self._clock()
        with self._lock:
            present = {tid: pid for pid, members in ctx["members"].items() for tid in members}
            gone = {e["id"] for entries in self._state["playlists"].values() for e in entries if e.get("gone")}
            dismissed = 0
            for v in self._state["videos"].values():
                picked = v.get("picked")
                if picked is None:
                    continue
                if picked in present:
                    pid = present[picked]
                    v.update(filed=True, playlistId=pid, held=None, dismissed=False)
                    if v.get("genre") is None:
                        v["genre"] = ctx["members"][pid][picked].get("genre")
                elif v.get("filed"):
                    if v.get("playlistId") in gone:
                        v.update(filed=False, held="gone")
                    else:  # it was filed and is gone from a playlist that exists: the owner took it out
                        v.update(filed=False, dismissed=True)
                        dismissed += 1
                if (
                    v["status"] == "unavailable"
                    and not v.get("filed")
                    and v["checks"]["next"] <= now
                    and v.get("unavailableChecks", 0) < UNAVAILABLE_RECHECKS
                ):
                    v["status"] = "matched"  # tried again on this run; verification decides again
            run["counts"]["dismissed"] = dismissed
            self._save_state()

    def _parsed(self, v: dict):
        return parse_track(
            v["title"], v["uploader"], v["durationSec"], source="youtube", uploader_is_artist=v.get("uploaderIsArtist", False)
        )

    @staticmethod
    def _scored(result) -> list[dict]:
        return [{**s.candidate, "score": round(s.score, 3)} for s in result.ranked[:KEEP_CANDIDATES]]

    def _match(self, run: dict) -> None:
        now = self._clock()
        with self._lock:
            todo = [
                vid
                for vid, v in sorted(self._state["videos"].items(), key=lambda kv: -kv[1].get("pos", 0))
                if v.get("liked")  # a song unliked before it was filed is left alone
                and (
                    v["status"] == "new"
                    or (v["status"] == "notfound" and v["checks"]["n"] < NOTFOUND_RECHECKS and v["checks"]["next"] <= now)
                )
            ]
        bp = self._beatport()
        streak, last_save = 0, self._clock()
        matched = 0
        for n, vid in enumerate(todo, 1):
            self._check(run)
            with self._lock:
                v = self._state["videos"][vid]
                parsed = self._parsed(v)
            query = search_query(parsed)
            found: list[dict] = []
            if query:
                try:
                    found = self._retry(run, lambda q=query: bp.search(q), "searching Beatport")
                except BeatportError as error:
                    if error.fatal or error.retryable:
                        raise
                    with self._lock:
                        v["error"] = str(error)
                    streak += 1
                    if streak >= 3:
                        raise SyncError(f"Beatport keeps failing ({error})", retryable=True) from None
                    continue
            streak = 0
            result = match_track(parsed, found)
            with self._lock:
                v.update(verdict=result.verdict, query=query, error=None, candidates=self._scored(result))
                if result.verdict == "match":
                    best = v["candidates"][0]
                    v.update(status="matched", picked=best["id"], genre=best.get("genre") or None, subGenre=best.get("subGenre"))
                    matched += 1
                elif result.verdict == "maybe":
                    v["status"] = "review"
                else:
                    v["status"] = "notfound"
                    v["checks"] = {"n": v["checks"]["n"] + 1, "next": self._clock() + NOTFOUND_RECHECK_SECS}
                if n % SAVE_EVERY == 0 or self._clock() - last_save >= SAVE_SECS:
                    self._save_state()
                    last_save = self._clock()
        with self._lock:
            run["counts"]["searched"] = len(todo)
            run["counts"]["matched"] = matched
            self._save_state()

    def _pending(self) -> list[tuple[str, dict]]:
        """Matched tracks that are not on Beatport yet, oldest like first (so playlist #1 holds the oldest)."""
        return [
            (vid, v)
            for vid, v in sorted(self._state["videos"].items(), key=lambda kv: -kv[1].get("pos", 0))
            if v["status"] == "matched"
            and v.get("liked")
            and v.get("picked") is not None
            and not v.get("filed")
            and not v.get("dismissed")
            and not v.get("held")
        ]

    def _fill_genres(self, run: dict) -> None:
        """A track picked by hand, or imported from a conversion, has no genre yet: ask Beatport for them in batches."""
        with self._lock:
            ids = list(dict.fromkeys(v["picked"] for _, v in self._pending() if v.get("genre") is None))
        if not ids:
            return
        bp = self._beatport()
        genres: dict[int, str | None] = {}
        for batch in chunks(ids, ADD_BATCH):
            self._check(run)
            for t in self._retry(run, lambda b=batch: bp.tracks_by_ids(b), "reading genres from Beatport"):
                genres[t["id"]] = t.get("genre")
        with self._lock:
            for _, v in self._pending():
                if v.get("genre") is None:
                    v["genre"] = genres.get(v["picked"]) or ""  # "" = Beatport has none: the catch-all group
            self._save_state()

    def _preview(self, ctx: dict) -> dict:
        cap = self._config["cap"]
        per: dict[str, int] = {}
        for _, v in self._pending():
            per[self._group_of(v)] = per.get(self._group_of(v), 0) + 1
        groups = []
        for g in self._groups():
            add = per.get(g["id"], 0)
            if not add:
                continue
            free = sum(
                max(0, cap - len(ctx["members"].get(e["id"], {})))
                for e in self._state["playlists"].get(g["id"], [])
                if not e.get("gone")
            )
            groups.append({"id": g["id"], "name": g["name"], "add": add, "newPlaylists": math.ceil(max(0, add - free) / cap)})
        videos = self._state["videos"].values()
        return {
            "groups": groups,
            "total": sum(g["add"] for g in groups),
            "newPlaylists": sum(g["newPlaylists"] for g in groups),
            "review": sum(1 for v in videos if v["status"] == "review"),
            "notFound": sum(1 for v in videos if v["status"] == "notfound"),
        }

    def _file(self, run: dict, ctx: dict) -> None:
        self._fill_genres(run)
        with self._lock:
            pending = self._pending()
        if not pending:
            return
        by_group: dict[str, list[str]] = {}
        for vid, v in pending:
            by_group.setdefault(self._group_of(v), []).append(vid)
        added = unavailable = 0
        for g in self._groups():
            vids = by_group.get(g["id"])
            if vids:
                a, u = self._file_group(run, ctx, g["id"], vids)
                added, unavailable = added + a, unavailable + u
        with self._lock:
            run["counts"].update(added=added, unavailable=unavailable)
            self._save_state()

    def _file_group(self, run: dict, ctx: dict, gid: str, vids: list[str]) -> tuple[int, int]:
        bp = self._beatport()
        cap = self._config["cap"]
        with self._lock:
            by_pick: dict[int, list[str]] = {}
            for vid in vids:
                by_pick.setdefault(self._state["videos"][vid]["picked"], []).append(vid)
            queue = list(by_pick)
            entries = [e for e in self._state["playlists"].setdefault(gid, []) if not e.get("gone")]
        plan: list[tuple[dict, list[int]]] = []
        for e in entries:
            free = max(0, cap - len(ctx["members"].get(e["id"], {})))
            plan.append((e, queue[:free]))
            queue = queue[free:]
        while queue:
            self._check(run)
            with self._lock:
                n = max((e["n"] for e in self._state["playlists"][gid]), default=0) + 1
            name = self._playlist_name(gid, n)
            made = self._retry(run, lambda nm=name: bp.create_playlist(nm), "creating a playlist")
            entry = {"id": made["id"], "url": made["url"], "name": name, "n": n, "gone": False, "count": 0}
            with self._lock:  # saved at once: a restart must never make a second playlist
                self._state["playlists"][gid].append(entry)
                self._save_state()
            ctx["members"][entry["id"]] = {}
            plan.append((entry, queue[:cap]))
            queue = queue[cap:]
        added = unavailable = 0
        for entry, ids in plan:
            if not ids:
                continue
            self._check(run)
            pid = entry["id"]
            fresh = {t["id"]: t for t in self._retry(run, lambda p=pid: bp.playlist_tracks(p), "reading a Beatport playlist")}
            todo = [i for i in ids if i not in fresh]
            for batch in chunks(todo, ADD_BATCH):
                self._check(run)
                self._retry(run, lambda p=pid, b=batch: bp.add_tracks(p, b), "adding tracks")  # the answer is not trusted
            after = {t["id"]: t for t in self._retry(run, lambda p=pid: bp.playlist_tracks(p), "checking the Beatport playlist")}
            if any(i not in after for i in ids):
                self._sleep(SETTLE_SECS)  # a stale read must not turn good tracks into "unavailable"
                self._check(run)
                after = {t["id"]: t for t in self._retry(run, lambda p=pid: bp.playlist_tracks(p), "checking the Beatport playlist")}
            ctx["members"][pid] = after
            with self._lock:
                entry["count"] = sum(1 for t in after.values() if not t.get("tombstoned"))
                for bid in ids:
                    for vid in by_pick[bid]:
                        v = self._state["videos"][vid]
                        if bid in after:
                            v.update(filed=True, playlistId=pid, held=None)
                            added += 1 if bid in todo else 0
                        else:
                            n_checks = v.get("unavailableChecks", 0) + 1
                            v.update(status="unavailable", unavailableChecks=n_checks, checks={"n": n_checks, "next": self._clock() + UNAVAILABLE_RECHECK_SECS})
                            unavailable += 1
                self._save_state()
        return added, unavailable
