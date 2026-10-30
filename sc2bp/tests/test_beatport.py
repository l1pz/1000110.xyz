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
        self.refused_tokens = 0  # how many API calls get a 401 before one is accepted
        self.available = True
        self.tokens_issued = 0

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
                return httpx.Response(self.search_status, text="secret body from beatport")
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
        {"id": 7, "title": "Higher State", "mix": "Original Mix", "artists": ["Solomun"], "durationSec": 400},
        {"id": 8, "title": "No Length", "mix": "", "artists": [], "durationSec": None},
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


def test_create_playlist_adds_in_batches_and_returns_the_link(world):
    fake, _, make, _ = world
    made = make().create_playlist("My set", list(range(1, 121)))
    assert made == {"name": "My set", "added": 120, "url": "https://www.beatport.com/library/playlists/99"}
    bulk = [r for r in fake.requests if r.url.path.endswith("/tracks/bulk/")]
    assert [len(json.loads(r.content)["track_ids"]) for r in bulk] == [50, 50, 20]
    assert bulk[0].url.path == "/v4/my/playlists/99/tracks/bulk/"


def test_tracks_beatport_cannot_play_are_not_counted(world):
    fake, _, make, _ = world
    fake.available = False
    assert make().create_playlist("x", [1, 2, 3])["added"] == 0
