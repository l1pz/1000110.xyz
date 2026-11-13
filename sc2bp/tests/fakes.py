"""Fakes for the two outside services, and a scenario with every kind of track."""

from beatport import BeatportError
import youtube
from errors import BadUrl, PlaylistError

PLAYLIST = "https://soundcloud.com/someone/sets/my-set"


class Crash(BaseException):
    """Stands for the server dying: it is not an Exception, so nothing in the job code can catch it."""


class Clock:
    def __init__(self):
        self.now = 1000.0
        self.slept = 0.0

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.slept += seconds
        self.now += seconds


def url(i):
    return f"https://soundcloud.com/a/t{i}"


# (kind, SoundCloud title); the kinds say how the fake Beatport answers
SCENARIO = [
    ("match", "Artist0 - Song0"),
    ("match", "Artist1 - Song1"),
    ("maybe", "Artist2 - Song2"),
    ("none", "Artist3 - Song3"),
    ("unreadable", ""),
    ("match", "Artist5 - Song5"),
    ("maybe", "Artist6 - Song6"),
    ("none", "Artist7 - Song7"),
]


class FakeSoundCloud:
    def check_url(self, link):
        return link.strip()

    def __init__(self, scenario=SCENARIO):
        self.scenario = scenario
        self.list_calls = 0
        self.read_calls: list[list[str]] = []
        self.list_error: Exception | None = None
        self.blank_once: set[str] = set()  # links that come back blank the first time only
        self.name = "My set"

    def list_playlist(self, link):
        self.list_calls += 1
        if self.list_error:
            raise self.list_error
        return {"name": self.name, "urls": [url(i) for i in range(len(self.scenario))]}

    def read_tracks(self, urls):
        self.read_calls.append(list(urls))
        out = []
        for link in urls:
            kind, title = self.scenario[int(link.rsplit("t", 1)[1])]
            if link in self.blank_once:
                self.blank_once.discard(link)
                title = ""
            out.append({"title": title, "uploader": "Up", "durationSec": 300.0 if title else None})
        return out


YOUTUBE_PLAYLIST = "https://www.youtube.com/playlist?list=PLabc123"  # already canonical


def yt_url(i):
    return f"https://www.youtube.com/watch?v=v{i}"


class FakeYouTube:
    """Reads titles while listing, like the real one: `read_tracks` must never be needed."""

    def __init__(self, scenario=SCENARIO, topic: set[int] = frozenset()):
        self.scenario = scenario
        self.topic = topic
        self.list_calls = 0
        self.read_calls: list[list[str]] = []
        self.name = "My mix"

    def check_url(self, link):
        return youtube.check_url(link)  # the real rules: they are what the routes and jobs rely on

    def list_playlist(self, link):
        self.list_calls += 1
        tracks = [
            {
                "title": title,
                "uploader": "Up",
                "durationSec": 300.0 if title else None,
                "uploaderIsArtist": i in self.topic,
            }
            for i, (_, title) in enumerate(self.scenario)
        ]
        return {"name": self.name, "urls": [yt_url(i) for i in range(len(tracks))], "tracks": tracks}

    def read_tracks(self, urls):
        self.read_calls.append(list(urls))
        raise AssertionError("YouTube tracks are read while listing")


class FakeBeatport:
    def __init__(self, scenario=SCENARIO):
        self.catalogue: dict[str, list[dict]] = {}
        for i, (kind, title) in enumerate(scenario):
            if not title:
                continue
            artist, song = (p.strip() for p in title.split(" - "))
            artists = [artist] if kind == "match" else ["Someone Else"]
            if kind != "none":
                self.catalogue[f"{artist} {song}"] = [
                    {"id": 1000 + i, "title": song, "mix": "Original Mix", "artists": artists, "durationSec": 300}
                ]
        self.queries: list[str] = []
        self.search_hook = None  # called with the number of this search; may raise
        self.add_hook = None
        self.created: list[str] = []
        self.playlists: dict[int, list[int]] = {}  # playlist id -> track ids in it
        self.add_calls: list[list[int]] = []
        self.added: list[int] = []
        self.unavailable: set[int] = set()

    def search(self, query):
        self.queries.append(query)
        if self.search_hook:
            self.search_hook(len(self.queries))
        return self.catalogue.get(query, [])

    def create_playlist(self, name):
        self.created.append(name)
        pid = 76 + len(self.created)  # the first is 77
        self.playlists[pid] = []
        return {"id": pid, "url": f"https://www.beatport.com/library/playlists/{pid}"}

    def add_tracks(self, playlist_id, ids):
        self.add_calls.append(list(ids))
        self.playlists.setdefault(playlist_id, [])
        if self.add_hook:
            self.add_hook(len(self.add_calls))
        took = [i for i in ids if i not in self.unavailable]
        self.added.extend(took)
        self.playlists[playlist_id].extend(took)
        return took


def transient(message="Beatport answered 503"):
    return BeatportError(message, retryable=True)


__all__ = ["BadUrl", "BeatportError", "PlaylistError"]
