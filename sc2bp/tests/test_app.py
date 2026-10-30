import app as service
import pytest
from beatport import BeatportError
from fastapi.testclient import TestClient
from soundcloud import BadUrl, PlaylistError


class FakeBeatport:
    def __init__(self):
        self.searched: list[str] = []
        self.created = None
        self.fail = False

    def search(self, query):
        if self.fail:
            raise BeatportError("Beatport answered 500 for GET /catalog/search")
        self.searched.append(query)
        return [{"id": len(query), "title": query, "mix": "", "artists": [], "durationSec": None}]

    def create_playlist(self, name, ids):
        self.created = (name, ids)
        return {"name": name, "added": len(ids), "url": "https://www.beatport.com/library/playlists/1"}


@pytest.fixture
def client():
    fake = FakeBeatport()
    service.app.dependency_overrides[service.get_beatport] = lambda: fake
    yield TestClient(service.app), fake
    service.app.dependency_overrides.clear()


def test_health_and_me(client):
    c, _ = client
    assert c.get("/api/sc2bp/health").json() == {"ok": True}
    assert c.get("/api/sc2bp/me").status_code == 200


def test_docs_are_off(client):
    c, _ = client
    assert c.get("/docs").status_code == 404
    assert c.get("/openapi.json").status_code == 404


def test_playlist_passes_the_lister_result_through(client):
    c, _ = client
    service.app.dependency_overrides[service.get_lister] = lambda: lambda url: {"name": "S", "urls": []}
    assert c.post("/api/sc2bp/playlist", json={"url": "https://soundcloud.com/a/sets/b"}).json()["name"] == "S"
    service.app.dependency_overrides.pop(service.get_lister)


def test_playlist_errors_become_400_and_502_with_a_detail(client):
    c, _ = client

    def bad(url):
        raise BadUrl("only https://soundcloud.com links work")

    def broken(url):
        raise PlaylistError("yt-dlp could not read that playlist")

    service.app.dependency_overrides[service.get_lister] = lambda: bad
    r = c.post("/api/sc2bp/playlist", json={"url": "https://evil.example"})
    assert (r.status_code, r.json()["detail"]) == (400, "only https://soundcloud.com links work")
    service.app.dependency_overrides[service.get_lister] = lambda: broken
    assert c.post("/api/sc2bp/playlist", json={"url": "https://soundcloud.com/a"}).status_code == 502
    service.app.dependency_overrides.pop(service.get_lister)


def test_tracks_returns_what_the_reader_gives(client):
    c, _ = client
    blank = {"title": "", "uploader": "", "durationSec": None}
    service.app.dependency_overrides[service.get_track_reader] = lambda: lambda urls: [blank for _ in urls]
    r = c.post("/api/sc2bp/tracks", json={"urls": ["https://soundcloud.com/a/one", "https://soundcloud.com/a/two"]})
    assert r.json() == {"tracks": [blank, blank]}
    service.app.dependency_overrides.pop(service.get_track_reader)


def test_tracks_refuses_other_hosts_and_big_batches(client):
    c, _ = client
    assert c.post("/api/sc2bp/tracks", json={"urls": ["https://evil.example/x"]}).status_code == 400
    assert c.post("/api/sc2bp/tracks", json={"urls": []}).status_code == 422
    assert c.post("/api/sc2bp/tracks", json={"urls": ["https://soundcloud.com/a/x"] * 11}).status_code == 422


def test_search_returns_one_list_per_query_and_skips_blanks(client):
    c, fake = client
    r = c.post("/api/sc2bp/search", json={"queries": ["a b", "", "   ", "c"]})
    assert [len(x) for x in r.json()["results"]] == [1, 0, 0, 1]
    assert fake.searched == ["a b", "c"]


def test_search_is_limited_to_ten_queries(client):
    c, _ = client
    assert c.post("/api/sc2bp/search", json={"queries": ["q"] * 11}).status_code == 422
    assert c.post("/api/sc2bp/search", json={"queries": ["q" * 201]}).status_code == 422


def test_beatport_errors_become_502_with_the_message(client):
    c, fake = client
    fake.fail = True
    r = c.post("/api/sc2bp/search", json={"queries": ["a"]})
    assert r.status_code == 502
    assert "500" in r.json()["detail"]


def test_create_drops_duplicate_ids_and_keeps_order(client):
    c, fake = client
    r = c.post("/api/sc2bp/create", json={"name": "  My set ", "ids": [3, 1, 3, 2, 1]})
    assert r.json()["added"] == 3
    assert fake.created == ("My set", [3, 1, 2])


def test_create_validates_its_input(client):
    c, _ = client
    assert c.post("/api/sc2bp/create", json={"name": "", "ids": [1]}).status_code == 422
    assert c.post("/api/sc2bp/create", json={"name": "x", "ids": []}).status_code == 422
    assert c.post("/api/sc2bp/create", json={"name": "x", "ids": ["a"]}).status_code == 422
    assert c.post("/api/sc2bp/create", json={"name": "x", "ids": list(range(501))}).status_code == 422


def test_missing_credentials_say_so(monkeypatch):
    monkeypatch.delenv("BEATPORT_USERNAME", raising=False)
    monkeypatch.delenv("BEATPORT_PASSWORD", raising=False)
    service.get_beatport.cache_clear()
    r = TestClient(service.app).post("/api/sc2bp/search", json={"queries": ["a"]})
    assert r.status_code == 503
    assert "not configured" in r.json()["detail"]
    service.get_beatport.cache_clear()
