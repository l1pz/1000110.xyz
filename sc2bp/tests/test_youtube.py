import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
import sources
import youtube
from errors import BadUrl, PlaylistError
from youtube import check_track_url, check_url, list_playlist, parse_listing, track_of

LIST = "https://www.youtube.com/playlist?list=PLabc_123-x"
FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "youtube_playlist.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize(
    "url",
    [
        "https://music.youtube.com/playlist?list=PLabc_123-x",
        "https://www.youtube.com/playlist?list=PLabc_123-x",
        "https://youtube.com/playlist?list=PLabc_123-x&si=tracking",
        "https://m.youtube.com/playlist?list=PLabc_123-x",
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc_123-x&index=3",
        "https://youtu.be/dQw4w9WgXcQ?list=PLabc_123-x",
        "  https://music.youtube.com/playlist?list=PLabc_123-x  ",
    ],
)
def test_every_playlist_link_form_becomes_the_one_canonical_address(url):
    assert check_url(url) == LIST


@pytest.mark.parametrize(
    "url",
    [
        "http://www.youtube.com/playlist?list=PLabc",
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ",  # a video, no playlist
        "https://www.youtube.com/playlist",
        "https://www.youtube.com/playlist?list=",
        "https://www.youtube.com/playlist?list=a&list=b",
        "https://www.youtube.com/playlist?list=PL abc",
        "https://www.youtube.com/playlist?list=PL;rm -rf",
        "https://youtube.com.evil.example/playlist?list=PLabc",
        "https://evil.example/youtube.com/playlist?list=PLabc",
        "https://user@evil.example/playlist?list=PLabc",
        "file:///etc/passwd",
        "not a link",
    ],
)
def test_other_links_are_refused(url):
    with pytest.raises(BadUrl):
        check_url(url)


def test_a_video_link_gets_a_reason_that_says_what_is_missing():
    with pytest.raises(BadUrl, match="list="):
        check_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ")


def test_track_links_stay_on_youtube_hosts():
    assert check_track_url("https://music.youtube.com/watch?v=abc") == "https://music.youtube.com/watch?v=abc"
    with pytest.raises(BadUrl):
        check_track_url("https://evil.example/watch?v=abc")


def test_the_source_is_picked_by_host():
    assert sources.source_of("https://soundcloud.com/a/sets/b") == "soundcloud"
    assert sources.source_of("https://music.youtube.com/playlist?list=PLabc") == "youtube"
    with pytest.raises(BadUrl, match="soundcloud or youtube"):
        sources.source_of("https://evil.example/x")


def test_a_real_listing_gives_titles_channels_and_lengths_at_once():
    listing = parse_listing(FIXTURE, LIST)
    assert listing["name"] == "Popular Music Videos"
    assert len(listing["urls"]) == len(listing["tracks"]) == 16
    first = listing["tracks"][0]
    assert first == {
        "title": "BELLAKEO (Video Oficial) - Peso Pluma, Anitta",
        "uploader": "Peso Pluma",
        "durationSec": 235.0,
        "uploaderIsArtist": False,
    }


def test_topic_channels_name_the_artist_and_vevo_is_trimmed():
    by_title = {t["title"]: t for t in parse_listing(FIXTURE, LIST)["tracks"]}
    assert by_title["Strobe"]["uploader"] == "deadmau5" and by_title["Strobe"]["uploaderIsArtist"] is True
    video = by_title["Some Artist - Some Song (Official Video)"]
    assert video["uploader"] == "SomeArtist" and video["uploaderIsArtist"] is False


def test_private_and_deleted_videos_come_back_blank():
    tracks = parse_listing(FIXTURE, LIST)["tracks"]
    assert [t["title"] for t in tracks[-2:]] == ["", ""]
    assert track_of({"title": "   "})["title"] == ""


def test_entries_without_a_youtube_link_are_skipped():
    data = {"entries": [{"url": "https://evil.example/x", "title": "x"}, None, {"title": "no link"}]}
    assert parse_listing(data, LIST)["urls"] == []


class Runner:
    """Stands for `subprocess.run`: remembers the command and answers with `out` or raises `error`."""

    def __init__(self, out=None, error=None):
        self.out, self.error, self.command = out, error, None

    def __call__(self, command, **_):
        self.command = command
        if self.error:
            raise self.error
        return SimpleNamespace(stdout=json.dumps(self.out))


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setenv("SC2BP_DATA", str(tmp_path))
    return tmp_path


def test_cookies_are_only_passed_when_the_file_exists(data_dir):
    run = Runner(FIXTURE)
    list_playlist(LIST, run=run)
    assert "--cookies" not in run.command and run.command[-2:] == ["--", LIST]
    (data_dir / "youtube-cookies.txt").write_text("# Netscape HTTP Cookie File\n")
    run = Runner(FIXTURE)
    list_playlist(LIST, run=run)
    assert run.command[run.command.index("--cookies") + 1] == str(data_dir / "youtube-cookies.txt")


def test_the_listing_is_fetched_by_the_canonical_address(data_dir):
    run = Runner(FIXTURE)
    list_playlist("https://music.youtube.com/playlist?list=PLabc_123-x&si=x", run=run)
    assert run.command[-1] == LIST


def failure(stderr):
    return subprocess.CalledProcessError(1, "yt-dlp", stderr=stderr)


@pytest.mark.parametrize(
    ("stderr", "retryable", "words"),
    [
        ("ERROR: Sign in to confirm you're not a bot", True, "bot"),
        ("ERROR: The playlist does not exist", False, "private or gone"),
        ("ERROR: This playlist is private", False, "private or gone"),
        ("ERROR: something new", False, "could not read"),
    ],
)
def test_failures_are_explained(data_dir, stderr, retryable, words):
    with pytest.raises(PlaylistError, match=words) as caught:
        list_playlist(LIST, run=Runner(error=failure(stderr)))
    assert caught.value.retryable is retryable


def test_a_timeout_can_be_retried(data_dir):
    with pytest.raises(PlaylistError) as caught:
        list_playlist(LIST, run=Runner(error=subprocess.TimeoutExpired("yt-dlp", 1)))
    assert caught.value.retryable


def test_an_empty_or_huge_playlist_is_refused(data_dir):
    with pytest.raises(PlaylistError, match="no tracks"):
        list_playlist(LIST, run=Runner({"entries": []}))
    many = {"entries": [{"url": f"https://www.youtube.com/watch?v={i}", "title": "t"} for i in range(youtube.MAX_TRACKS + 1)]}
    with pytest.raises(PlaylistError, match="more than"):
        list_playlist(LIST, run=Runner(many))


def test_a_caller_may_raise_the_track_limit(data_dir):
    many = {"entries": [{"url": f"https://www.youtube.com/watch?v={i}", "title": "t"} for i in range(youtube.MAX_TRACKS + 5)]}
    assert len(list_playlist(LIST, run=Runner(many), max_tracks=youtube.MAX_TRACKS + 10)["urls"]) == youtube.MAX_TRACKS + 5
    with pytest.raises(PlaylistError, match="more than 10 tracks"):
        list_playlist(LIST, run=Runner(many), max_tracks=10)
