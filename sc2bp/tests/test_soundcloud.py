import json
import subprocess
from types import SimpleNamespace

import pytest
from soundcloud import MAX_TRACKS, BadUrl, PlaylistError, check_track_url, check_url, list_playlist, parse_listing, read_tracks, track_of


@pytest.mark.parametrize(
    "url",
    [
        "https://soundcloud.com/user/sets/name",
        "https://www.soundcloud.com/user/sets/name",
        "https://on.soundcloud.com/abc",
        "  https://soundcloud.com/user/sets/name  ",
    ],
)
def test_soundcloud_links_pass(url):
    assert check_url(url) == url.strip()


@pytest.mark.parametrize(
    "url",
    [
        "http://soundcloud.com/user/sets/name",
        "https://soundcloud.com.evil.example/x",
        "https://evil.example/soundcloud.com",
        "https://user@evil.example/",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "not a link",
        "",
    ],
)
def test_other_links_are_refused(url):
    with pytest.raises(BadUrl):
        check_url(url)


def test_api_track_links_are_accepted_only_in_their_exact_form():
    for ok in ("https://api-v2.soundcloud.com/tracks/1911414692", "https://api.soundcloud.com/tracks/5"):
        assert check_track_url(ok) == ok
    for bad in (
        "https://api-v2.soundcloud.com/me",
        "https://api-v2.soundcloud.com/tracks/12/related",
        "https://api-v2.soundcloud.com/tracks/12?client_id=x",
        "https://api-v2.soundcloud.com.evil.example/tracks/12",
        "http://api-v2.soundcloud.com/tracks/12",
    ):
        with pytest.raises(BadUrl):
            check_track_url(bad)
    # a playlist link is still public hosts only
    with pytest.raises(BadUrl):
        check_url("https://api-v2.soundcloud.com/tracks/12")


def test_parse_listing_keeps_only_soundcloud_track_links():
    data = {
        "title": "My set",
        "entries": [
            {"url": "https://soundcloud.com/a/one"},
            {"url": "https://evil.example/x"},
            {"url": None},
            {"title": "no url"},
            "junk",
            {"url": "https://soundcloud.com/a/two"},
            {"url": "https://api-v2.soundcloud.com/tracks/123"},
            {"url": "https://api-v2.soundcloud.com/me"},
        ],
    }
    assert parse_listing(data, "https://soundcloud.com/a/sets/s") == {
        "name": "My set",
        "urls": [
            "https://soundcloud.com/a/one",
            "https://soundcloud.com/a/two",
            "https://api-v2.soundcloud.com/tracks/123",
        ],
    }


def test_a_single_track_link_is_a_one_track_list():
    url = "https://soundcloud.com/a/one"
    assert parse_listing({"title": "A - B"}, url) == {"name": "A - B", "urls": [url]}


def fake_run(stdout="", error=None):
    calls = []

    def run(command, **kwargs):
        calls.append((command, kwargs))
        if error:
            raise error
        return SimpleNamespace(stdout=stdout)

    run.calls = calls
    return run


def test_list_playlist_runs_yt_dlp_without_a_shell_and_after_a_double_dash():
    run = fake_run(json.dumps({"title": "Set", "entries": [{"url": "https://soundcloud.com/a/one"}]}))
    assert list_playlist("https://soundcloud.com/u/sets/s", run) == {
        "name": "Set",
        "urls": ["https://soundcloud.com/a/one"],
    }
    command, kwargs = run.calls[0]
    assert command[0] == "yt-dlp"
    assert command[-2:] == ["--", "https://soundcloud.com/u/sets/s"]
    assert "--flat-playlist" in command
    assert not kwargs.get("shell")
    assert kwargs["timeout"] > 0


def test_a_bad_link_never_reaches_yt_dlp():
    run = fake_run("{}")
    with pytest.raises(BadUrl):
        list_playlist("https://evil.example/x", run)
    assert run.calls == []


def test_yt_dlp_failure_gives_a_playlist_error_without_its_stderr():
    error = subprocess.CalledProcessError(1, "yt-dlp", stderr="secret details")
    with pytest.raises(PlaylistError) as caught:
        list_playlist("https://soundcloud.com/u/sets/s", fake_run(error=error))
    assert "secret details" not in str(caught.value)


def test_timeout_bad_output_empty_and_huge_playlists():
    url = "https://soundcloud.com/u/sets/s"
    with pytest.raises(PlaylistError, match="too long") as timed_out:
        list_playlist(url, fake_run(error=subprocess.TimeoutExpired("yt-dlp", 1)))
    assert timed_out.value.retryable
    with pytest.raises(PlaylistError, match="could not read"):
        list_playlist(url, fake_run("not json"))
    with pytest.raises(PlaylistError, match="no tracks"):
        list_playlist(url, fake_run(json.dumps({"title": "x", "entries": []})))
    many = {"title": "x", "entries": [{"url": f"https://soundcloud.com/a/{i}"} for i in range(MAX_TRACKS + 1)]}
    with pytest.raises(PlaylistError, match="more than"):
        list_playlist(url, fake_run(json.dumps(many)))


def test_track_of_reads_title_uploader_and_length():
    assert track_of({"title": "A - B", "uploader": "A", "duration": 291.1}) == {
        "title": "A - B",
        "uploader": "A",
        "durationSec": 291.1,
    }
    assert track_of({"title": "A - B", "channel": "C"})["uploader"] == "C"
    blank = {"title": "", "uploader": "", "durationSec": None}
    assert track_of(None) == blank
    assert track_of({"uploader": "x"}) == blank


def test_read_tracks_keeps_the_order_and_blanks_what_fails():
    def extract(url):
        if url.endswith("/gone"):
            raise RuntimeError("HTTP Error 404")
        return {"title": url.rsplit("/", 1)[1], "uploader": "u", "duration": 1}

    urls = [f"https://soundcloud.com/a/{name}" for name in ("one", "gone", "three", "four")]
    result = read_tracks(urls, extract, workers=3)
    assert [t["title"] for t in result] == ["one", "", "three", "four"]


def test_read_tracks_refuses_other_hosts_before_extracting_anything():
    seen = []
    with pytest.raises(BadUrl):
        read_tracks(["https://soundcloud.com/a/one", "https://evil.example/x"], seen.append)
    assert seen == []
