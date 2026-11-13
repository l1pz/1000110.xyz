"""Fakes for the sync: a Beatport library that can lie the way the real one did, and a YouTube likes list."""

from datetime import datetime
from zoneinfo import ZoneInfo

import youtube
from beatport import BeatportError
from errors import PlaylistError
from fakes import Clock
from syncer import Syncer

TECHNO = "Techno (Peak Time / Driving)"
HOUSE = "House"
ROCK = "Rock"

# (kind, "Artist - Song", Beatport genre); the kind says how the fake Beatport answers a search for it
LIKED = [
    ("match", "Artist0 - Song0", TECHNO),
    ("match", "Artist1 - Song1", TECHNO),
    ("match", "Artist2 - Song2", HOUSE),
    ("match", "Artist3 - Song3", TECHNO),
    ("maybe", "Artist4 - Song4", HOUSE),
    ("none", "Artist5 - Song5", None),
    ("match", "Artist6 - Song6", ROCK),
    ("blank", "", None),
]


def vid(i):
    return f"v{i}"


class FakeLikes:
    """The YouTube side: a list of liked songs, newest first, like the real listing."""

    def __init__(self, scenario=LIKED, liked=None):
        self.entries = [(vid(i), title) for i, (_, title, _) in enumerate(scenario[:liked])]
        self.error: Exception | None = None
        self.calls = 0
        self.max_tracks = None

    def check_url(self, link):
        return youtube.check_url(link)

    def like(self, video, title):
        self.entries.insert(0, (video, title))

    def unlike(self, video):
        self.entries = [e for e in self.entries if e[0] != video]

    def list_playlist(self, link, max_tracks=None):
        self.calls += 1
        self.max_tracks = max_tracks
        if self.error:
            raise self.error
        return {
            "name": "Liked Music",
            "urls": [f"https://music.youtube.com/watch?v={v}" for v, _ in self.entries],
            "tracks": [
                {"title": t, "uploader": "Up", "durationSec": 300.0 if t else None, "uploaderIsArtist": False}
                for _, t in self.entries
            ],
        }


class FakeLibrary:
    """The Beatport side: a catalogue and the owner's playlists, with the failure modes seen on the real one."""

    def __init__(self, scenario=LIKED):
        self.tracks: dict[int, dict] = {}
        self.catalogue: dict[str, list[int]] = {}
        for i, (kind, title, genre) in enumerate(scenario):
            if not title:
                continue
            artist, song = (p.strip() for p in title.split(" - "))
            if kind == "none":
                continue
            bid = 2000 + i
            self.tracks[bid] = {
                "id": bid,
                "title": song,
                "mix": "Original Mix",
                "artists": [artist] if kind == "match" else ["Someone Else"],
                "durationSec": 300,
                "genre": genre,
                "subGenre": None,
            }
            self.catalogue[f"{artist} {song}"] = [bid]
        self.names: dict[int, str] = {}
        self.items: dict[int, list[int]] = {}
        self.next_id = 500
        self.tombstoned: set[int] = set()
        self.reject: set[int] = set()  # accepted by the add call, never kept (the answer lies)
        self.hide: set[int] = set()  # kept, but left out of the add answer (the answer lies the other way)
        self.calls: list[tuple] = []
        self.lag = False  # the first read after an add still shows the old playlist (a stale read)
        self._stale: set[int] = set()
        self.add_hook = None
        self.search_hook = None
        self.search_error: Exception | None = None

    def count(self, name):
        return sum(1 for c in self.calls if c[0] == name)

    def search(self, query):
        self.calls.append(("search", query))
        if self.search_hook:
            self.search_hook(self.count("search"))
        if self.search_error:
            raise self.search_error
        return [dict(self.tracks[i]) for i in self.catalogue.get(query, [])]

    def my_playlists(self):
        self.calls.append(("my_playlists",))
        return [
            {"id": p, "name": n, "count": len(self.items[p]), "url": f"https://www.beatport.com/library/playlists/{p}"}
            for p, n in self.names.items()
        ]

    def playlist_tracks(self, playlist_id):
        self.calls.append(("playlist_tracks", playlist_id))
        shown = [i for i in self.items[playlist_id] if i not in self._stale]
        self._stale.clear()
        return [{**self.tracks[i], "tombstoned": i in self.tombstoned} for i in shown]

    def tracks_by_ids(self, ids):
        self.calls.append(("tracks_by_ids", tuple(ids)))
        return [dict(self.tracks[i]) for i in ids if i in self.tracks]

    def create_playlist(self, name):
        self.calls.append(("create_playlist", name))
        self.next_id += 1
        self.names[self.next_id] = name
        self.items[self.next_id] = []
        return {"id": self.next_id, "url": f"https://www.beatport.com/library/playlists/{self.next_id}"}

    def add_tracks(self, playlist_id, ids):
        self.calls.append(("add_tracks", playlist_id, tuple(ids)))
        if self.add_hook:
            self.add_hook(self.count("add_tracks"))
        for i in ids:
            if i not in self.reject and i not in self.items[playlist_id]:
                self.items[playlist_id].append(i)
                if self.lag:
                    self._stale.add(i)
        return [i for i in ids if i not in self.hide]

    # --- what the owner does on Beatport by hand ---------------------------------------------------------------

    def remove(self, playlist_id, track_id):
        self.items[playlist_id].remove(track_id)

    def delete_playlist(self, playlist_id):
        del self.names[playlist_id], self.items[playlist_id]

    def by_name(self, name):
        return next(p for p, n in self.names.items() if n == name)


def transient(message="Beatport answered 503"):
    return BeatportError(message, retryable=True)


COOKIES = PlaylistError(
    "that playlist is private or gone; for a private one the YouTube cookies on the server may be missing or expired"
)


BUDAPEST = ZoneInfo("Europe/Budapest")
NOON = datetime(2026, 11, 13, 12, 0, tzinfo=BUDAPEST).timestamp()
DAY = 86400
SOURCE = "https://www.youtube.com/playlist?list=LM"


class World:
    def __init__(self, tmp_path, scenario=LIKED, liked=None):
        self.dir = tmp_path
        self.clock = Clock()
        self.clock.now = NOON
        self.yt = FakeLikes(scenario, liked)
        self.bp = FakeLibrary(scenario)
        self.syncer = self.start()

    def start(self):
        """A new server process on the same data directory."""
        return Syncer(self.dir, self.yt, lambda: self.bp, sleep=self.clock.sleep, clock=self.clock)

    def run(self, kind="manual", confirm=True):
        run, _ = self.syncer.start_run(kind)
        self.syncer.process_next()
        view = self.syncer.get_run(run["id"])
        if view["state"] == "awaiting" and confirm:
            self.syncer.confirm_run(run["id"])
            self.syncer.process_next()
            view = self.syncer.get_run(run["id"])
        return view

    def contents(self):
        return {self.bp.names[p]: sorted(ids) for p, ids in self.bp.items.items()}

    def video(self, i):
        return self.syncer._state["videos"][vid(i)]

    def later(self, days):
        self.clock.now += days * DAY
