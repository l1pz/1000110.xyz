import json
import stat
import sys

import httpx
import pytest
from beatport import Beatport, BeatportError, candidate


class FakeBeatport:
    """A scripted Beatport: records every request and answers by path."""

    def __init__(self):
        self.requests: list[httpx.Request] = []
        self.login_ok = True
        self.code = "CODE1"
        self.search_status = 200
        self.search_headers: dict[str, str] = {}
        self.refused_tokens = 0  # how many API calls get a 401 before one is accepted
        self.available = True
        self.tokens_issued = 0
        self.pages: dict[str, list[dict]] = {}  # GET path -> the pages (each a full answer body) to serve in order

    def paths(self):
        return [f"{r.method} {r.url.path}" for r in self.requests]

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if path == "/v4/docs/":
            return httpx.Response(200, text='<script src="/static/a.js"></script><script src="/static/b.js"></script>')
        if path == "/static/a.js":
            return httpx.Response(200, text="nothing here")
        if path == "/static/b.js":
            return httpx.Response(200, text="var x = {API_CLIENT_ID: 'client-xyz'}")
        if path == "/v4/auth/login/":
            body = {"username": "me", "email": "me@example.com"} if self.login_ok else {"detail": "bad login"}
            return httpx.Response(200, json=body)
        if path == "/v4/auth/o/authorize/":
            location = f"/v4/auth/o/post-message/?code={self.code}" if self.code else "/v4/auth/o/post-message/"
            return httpx.Response(302, headers={"location": location})
        if path == "/v4/auth/o/token/":
            self.tokens_issued += 1
            return httpx.Response(
                200,
                json={"access_token": f"access{self.tokens_issued}", "refresh_token": "refresh", "expires_in": 600},
            )
        if self.refused_tokens > 0:
            self.refused_tokens -= 1
            return httpx.Response(401, json={"detail": "expired"})
        if path == "/v4/catalog/search":  # the real API redirects to the slash form
            return httpx.Response(301, headers={"location": f"/v4/catalog/search/?{request.url.query.decode()}"})
        if path == "/v4/catalog/search/":
            if self.search_status != 200:
                return httpx.Response(self.search_status, text="secret body from beatport", headers=self.search_headers)
            return httpx.Response(
                200,
                json={
                    "tracks": [
                        {
                            "id": 7,
                            "name": "Higher State",
                            "mix_name": "Original Mix",
                            "artists": [{"id": 1, "name": "Solomun"}],
                            "length_ms": 400400,
                        },
                        {"id": 8, "name": "No Length", "artists": []},
                        {"name": "no id"},
                    ]
                },
            )
        if request.method == "GET" and path in self.pages:
            number = int(request.url.params.get("page", "1"))
            pages = self.pages[path]
            body = dict(pages[min(number, len(pages)) - 1])
            body["next"] = f"{path}?page={number + 1}" if number < len(pages) else None
            return httpx.Response(200, json=body)
        if path == "/v4/my/playlists/":
            return httpx.Response(201, json={"id": 99, "name": "x"})
        if path.endswith("/tracks/bulk/"):
            ids = json.loads(request.content)["track_ids"]
            items = [{"id": i, "track_id": i, "position": n, "track_available": self.available} for n, i in enumerate(ids)]
            return httpx.Response(200, json={"items": items})
        return httpx.Response(404)


class Clock:
    def __init__(self):
        self.now = 1000.0
        self.slept: list[float] = []

    def __call__(self):
        return self.now

    def sleep(self, secs):
        self.slept.append(secs)
        self.now += secs


@pytest.fixture
def world(tmp_path):
    fake, clock = FakeBeatport(), Clock()

    def make():
        return Beatport(
            "me",
            "pw",
            tmp_path / "data" / "token.json",
            transport=httpx.MockTransport(fake.handler),
            sleep=clock.sleep,
            clock=clock,
        )

    return fake, clock, make, tmp_path / "data" / "token.json"


def test_first_call_logs_in_with_the_documented_flow(world):
    fake, _, make, _ = world
    make().search("solomun higher state")
    assert fake.paths()[:3] == ["GET /v4/docs/", "GET /static/a.js", "GET /static/b.js"]
    assert fake.paths()[3:6] == ["POST /v4/auth/login/", "GET /v4/auth/o/authorize/", "POST /v4/auth/o/token/"]
    login = fake.requests[3]
    assert json.loads(login.content) == {"username": "me", "password": "pw"}
    token = fake.requests[5]
    assert token.url.params["code"] == "CODE1"
    assert token.url.params["client_id"] == "client-xyz"
    assert token.url.params["grant_type"] == "authorization_code"
    api = fake.requests[6]
    assert api.headers["authorization"] == "Bearer access1"
    assert api.url.params["type"] == "tracks"
    assert api.url.params["q"] == "solomun higher state"


def test_search_uses_the_slash_form_and_would_survive_a_redirect(world):
    fake, _, make, _ = world
    make().search("x")
    assert "GET /v4/catalog/search/" in fake.paths()
    assert "GET /v4/catalog/search" not in fake.paths()
    # a call without the slash is redirected by the (fake) API, and the client follows it
    bp = make()
    bp.search("warm up")
    assert bp._request("GET", "/catalog/search", params={"q": "x", "type": "tracks"})["tracks"]


def test_httpx_request_logging_is_quiet_so_codes_stay_out_of_the_log():
    import logging

    assert logging.getLogger("httpx").getEffectiveLevel() >= logging.WARNING


def test_search_maps_tracks_to_candidates(world):
    _, _, make, _ = world
    assert make().search("x") == [
        {
            "id": 7,
            "title": "Higher State",
            "mix": "Original Mix",
            "artists": ["Solomun"],
            "durationSec": 400,
            "genre": None,
            "subGenre": None,
        },
        {"id": 8, "title": "No Length", "mix": "", "artists": [], "durationSec": None, "genre": None, "subGenre": None},
    ]


def test_candidate_handles_odd_fields():
    assert candidate({"id": "5", "name": None, "artists": ["junk"], "length_ms": 0})["durationSec"] is None
    assert candidate({"id": "5", "artists": ["junk"]})["artists"] == []


def test_the_token_is_saved_and_reused_by_a_new_instance(world):
    fake, _, make, path = world
    make().search("x")
    saved = json.loads(path.read_text())
    assert saved["access_token"] == "access1" and saved["client_id"] == "client-xyz"
    if sys.platform != "win32":
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
    fake.requests.clear()
    make().search("y")
    assert "POST /v4/auth/login/" not in fake.paths()


def test_an_expired_token_is_refreshed_not_relogged(world):
    fake, clock, make, _ = world
    bp = make()
    bp.search("x")
    clock.now += 10_000
    fake.requests.clear()
    bp.search("y")
    assert fake.paths()[0] == "POST /v4/auth/o/token/"
    assert fake.requests[0].url.params["grant_type"] == "refresh_token"
    assert "POST /v4/auth/login/" not in fake.paths()
    assert fake.requests[1].headers["authorization"] == "Bearer access2"


def test_a_refused_token_logs_in_again_once_then_retries(world):
    fake, _, make, _ = world
    bp = make()
    bp.search("x")
    fake.refused_tokens = 1
    fake.requests.clear()
    assert bp.search("y")
    assert fake.paths().count("POST /v4/auth/login/") == 1


def test_a_token_refused_twice_is_an_error(world):
    fake, _, make, _ = world
    bp = make()
    bp.search("x")
    fake.refused_tokens = 5
    with pytest.raises(BeatportError, match="401"):
        bp.search("y")


def test_login_problems_have_clear_messages(world):
    fake, _, make, _ = world
    fake.login_ok = False
    with pytest.raises(BeatportError, match="refused the login"):
        make().search("x")
    fake.login_ok = True
    fake.code = ""
    with pytest.raises(BeatportError, match="authorization code"):
        make().search("x")


def test_errors_do_not_leak_the_beatport_body(world):
    fake, _, make, _ = world
    fake.search_status = 500
    with pytest.raises(BeatportError) as caught:
        make().search("x")
    assert "secret body" not in str(caught.value)
    assert "500" in str(caught.value)


def test_calls_are_spaced(world):
    _, clock, make, _ = world
    bp = make()
    bp.search("a")
    bp.search("b")
    assert any(0 < gap <= 0.4 for gap in clock.slept)


def test_create_playlist_returns_the_id_and_the_link(world):
    fake, _, make, _ = world
    made = make().create_playlist("My set")
    assert made == {"id": 99, "url": "https://www.beatport.com/library/playlists/99"}
    assert json.loads(fake.requests[-1].content) == {"name": "My set"}


def test_add_tracks_posts_the_ids_and_returns_the_ones_beatport_took(world):
    fake, _, make, _ = world
    assert make().add_tracks(99, [1, 2, 3]) == [1, 2, 3]
    bulk = fake.requests[-1]
    assert bulk.url.path == "/v4/my/playlists/99/tracks/bulk/"
    assert json.loads(bulk.content) == {"track_ids": [1, 2, 3]}


def test_tracks_beatport_cannot_play_are_left_out_of_the_answer(world):
    fake, _, make, _ = world
    fake.available = False
    assert make().add_tracks(99, [1, 2, 3]) == []


def test_add_tracks_refuses_more_than_one_batch(world):
    _, _, make, _ = world
    with pytest.raises(ValueError):
        make().add_tracks(99, list(range(51)))


@pytest.mark.parametrize(
    ("status", "retryable", "fatal"),
    [(429, True, False), (500, True, False), (503, True, False), (400, False, False), (403, False, True)],
)
def test_errors_say_whether_trying_again_could_help(world, status, retryable, fatal):
    fake, _, make, _ = world
    fake.search_status = status
    with pytest.raises(BeatportError) as caught:
        make().search("x")
    assert (caught.value.retryable, caught.value.fatal) == (retryable, fatal)


def test_a_rate_limit_carries_beatports_wait(world):
    fake, _, make, _ = world
    fake.search_status = 429
    fake.search_headers = {"retry-after": "42"}
    with pytest.raises(BeatportError) as caught:
        make().search("x")
    assert caught.value.retry_after == 42


def test_a_refused_login_is_fatal_and_a_lost_connection_is_retryable(world, tmp_path):
    fake, _, make, _ = world
    fake.login_ok = False
    with pytest.raises(BeatportError) as caught:
        make().search("x")
    assert caught.value.fatal and not caught.value.retryable

    def dead(request):
        raise httpx.ConnectError("no route")

    bp = Beatport("me", "pw", tmp_path / "t.json", transport=httpx.MockTransport(dead), sleep=lambda s: None)
    with pytest.raises(BeatportError) as caught:
        bp.search("x")
    assert caught.value.retryable and not caught.value.fatal


# --- genre, playlists and their contents (the sync) ------------------------------------------------------------

TECHNO = {"id": 90, "name": "Techno (Peak Time / Driving)", "slug": "techno-peak-time-driving"}


def test_a_candidate_carries_the_genre_and_sub_genre_names_only():
    track = {"id": 1, "name": "x", "genre": TECHNO, "sub_genre": {"id": 3, "name": "Tech Trance"}}
    got = candidate(track)
    assert (got["genre"], got["subGenre"]) == ("Techno (Peak Time / Driving)", "Tech Trance")
    assert candidate({"id": 1, "genre": "junk", "sub_genre": {"name": ""}})["genre"] is None
    assert "available" not in got  # the catalogue flag does not predict what a playlist accepts


def test_my_playlists_follows_every_page_and_skips_rows_without_an_id(world):
    fake, _, make, _ = world
    fake.pages["/v4/my/playlists/"] = [
        {"results": [{"id": 1, "name": "Liked - Techno #1", "track_count": 100}, {"name": "no id"}]},
        {"results": [{"id": 2, "name": "Other", "track_count": None}]},
    ]
    assert make().my_playlists() == [
        {"id": 1, "name": "Liked - Techno #1", "count": 100, "url": "https://www.beatport.com/library/playlists/1"},
        {"id": 2, "name": "Other", "count": 0, "url": "https://www.beatport.com/library/playlists/2"},
    ]
    asked = [r.url.params["page"] for r in fake.requests if r.url.path == "/v4/my/playlists/"]
    assert asked == ["1", "2"]


def test_playlist_tracks_are_what_is_really_in_it_with_tombstones_marked(world):
    fake, _, make, _ = world
    fake.pages["/v4/my/playlists/5/tracks/"] = [
        {"results": [{"id": 1, "position": 0, "tombstoned": False, "track": {"id": 10, "name": "A", "genre": TECHNO}}]},
        {"results": [{"id": 2, "position": 1, "tombstoned": True, "track": {"id": 11, "name": "B"}}, {"id": 3}]},
    ]
    tracks = make().playlist_tracks(5)
    assert [(t["id"], t["tombstoned"], t["genre"]) for t in tracks] == [
        (10, False, "Techno (Peak Time / Driving)"),
        (11, True, None),
    ]


def test_a_list_that_never_ends_is_an_error_not_a_hang(world, monkeypatch):
    import beatport

    fake, _, make, _ = world
    monkeypatch.setattr(beatport, "MAX_PAGES", 3)

    fake.pages["/v4/my/playlists/"] = [{"results": []}] * 50
    with pytest.raises(BeatportError, match="more pages"):
        make().my_playlists()


def test_tracks_by_ids_asks_in_batches_and_leaves_out_unknown_ids(world):
    fake, _, make, _ = world
    fake.pages["/v4/catalog/tracks/"] = [{"results": [{"id": 1, "name": "A", "genre": TECHNO}]}]
    got = make().tracks_by_ids(list(range(1, 121)))  # 120 ids: three requests of at most 50
    calls = [r for r in fake.requests if r.url.path == "/v4/catalog/tracks/"]
    assert [len(c.url.params["id"].split(",")) for c in calls] == [50, 50, 20]
    assert [t["id"] for t in got] == [1, 1, 1]  # the fake answers the same row each time; unknown ids just return nothing
    assert make().tracks_by_ids([]) == []


def test_a_failing_page_raises_the_usual_error_with_its_class(world):
    fake, _, make, _ = world
    fake.pages["/v4/my/playlists/"] = [{"results": []}]
    original = fake.handler

    def broken(request):
        if request.url.path == "/v4/my/playlists/":
            return httpx.Response(503)
        return original(request)

    beatport = Beatport("me", "pw", world[3], transport=httpx.MockTransport(broken), sleep=lambda s: None)
    with pytest.raises(BeatportError) as caught:
        beatport.my_playlists()
    assert caught.value.retryable
