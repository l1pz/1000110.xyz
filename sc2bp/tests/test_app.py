import app as service
import pytest
from beatport import BeatportError
from fakes import PLAYLIST, Clock, FakeBeatport, FakeSoundCloud, transient
from fastapi.testclient import TestClient
from jobs import Runner


@pytest.fixture
def world(tmp_path):
    sc, bp, clock = FakeSoundCloud(), FakeBeatport(), Clock()
    runner = Runner(tmp_path, sc, lambda: bp, sleep=clock.sleep, clock=clock)
    service.app.state.runner = runner  # the lifespan (and its worker thread) is not started in tests

    class World:
        client = TestClient(service.app)

    World.runner, World.sc, World.bp = runner, sc, bp
    yield World
    del service.app.state.runner


def start(world, **body):
    r = world.client.post("/api/sc2bp/jobs", json={"url": PLAYLIST, **body})
    assert r.status_code == 200, r.text
    return r.json()["job"]["id"]


def test_health_and_me(world):
    assert world.client.get("/api/sc2bp/health").json() == {"ok": True}
    assert world.client.get("/api/sc2bp/me").status_code == 200


def test_docs_are_off(world):
    assert world.client.get("/docs").status_code == 404
    assert world.client.get("/openapi.json").status_code == 404


def test_starting_a_job_returns_it_and_a_second_start_returns_the_same_one(world):
    first = world.client.post("/api/sc2bp/jobs", json={"url": PLAYLIST}).json()
    again = world.client.post("/api/sc2bp/jobs", json={"url": PLAYLIST}).json()
    assert first["created"] is True and again["created"] is False
    assert first["job"]["id"] == again["job"]["id"] and first["job"]["state"] == "queued"


def test_a_link_that_is_not_soundcloud_gets_a_400_with_the_reason(world):
    r = world.client.post("/api/sc2bp/jobs", json={"url": "https://evil.example/x"})
    assert (r.status_code, r.json()["detail"]) == (400, "only https://soundcloud.com links work")


def test_the_job_list_and_one_job_show_progress_and_the_result(world):
    job_id = start(world, name="Friday")
    world.runner.process_next()
    listed = world.client.get("/api/sc2bp/jobs").json()["jobs"]
    assert [j["id"] for j in listed] == [job_id]
    job = world.client.get(f"/api/sc2bp/jobs/{job_id}").json()["job"]
    assert job["state"] == "done" and job["name"] == "Friday" and job["counts"]["added"] == 3
    assert job["playlist"]["url"].startswith("https://www.beatport.com/library/playlists/")
    assert job["progress"] == {"phase": "finished", "done": 1, "total": 1}


def test_an_unknown_job_is_a_404(world):
    assert world.client.get("/api/sc2bp/jobs/00000000").status_code == 404
    assert world.client.get("/api/sc2bp/jobs/..%2F..%2Fetc").status_code == 404
    assert world.client.post("/api/sc2bp/jobs/00000000/cancel").status_code == 404
    assert world.client.delete("/api/sc2bp/jobs/00000000").status_code == 404
    assert world.client.get("/api/sc2bp/jobs/00000000/tracks").status_code == 404


def test_tracks_are_filtered_and_paged(world):
    job_id = start(world)
    world.runner.process_next()
    r = world.client.get(f"/api/sc2bp/jobs/{job_id}/tracks", params={"filter": "maybe"}).json()
    assert r["total"] == 2 and [t["index"] for t in r["tracks"]] == [2, 6]
    page = world.client.get(f"/api/sc2bp/jobs/{job_id}/tracks", params={"filter": "all", "limit": 3, "offset": 6})
    assert [t["index"] for t in page.json()["tracks"]] == [6, 7]
    assert world.client.get(f"/api/sc2bp/jobs/{job_id}/tracks", params={"filter": "nope"}).status_code == 400
    assert world.client.get(f"/api/sc2bp/jobs/{job_id}/tracks", params={"limit": 101}).status_code == 422


def test_cancel_retry_and_delete_answer_with_the_reason_when_they_cannot(world):
    job_id = start(world)
    assert world.client.post(f"/api/sc2bp/jobs/{job_id}/retry").status_code == 409  # still queued
    world.runner.process_next()
    r = world.client.post(f"/api/sc2bp/jobs/{job_id}/cancel")
    assert r.status_code == 409 and "cannot be cancelled" in r.json()["detail"]
    assert world.client.post(f"/api/sc2bp/jobs/{job_id}/retry").json()["detail"] == "nothing to retry"
    assert world.client.delete(f"/api/sc2bp/jobs/{job_id}").json() == {"ok": True}
    assert world.client.get("/api/sc2bp/jobs").json() == {"jobs": []}


def test_cancelling_a_queued_job(world):
    job_id = start(world)
    assert world.client.post(f"/api/sc2bp/jobs/{job_id}/cancel").json()["job"]["state"] == "cancelled"


def test_pick_then_apply(world):
    job_id = start(world)
    world.runner.process_next()
    r = world.client.post(f"/api/sc2bp/jobs/{job_id}/tracks/2/pick", json={"id": 1002})
    assert r.json()["track"]["picked"] == 1002
    assert world.client.post(f"/api/sc2bp/jobs/{job_id}/tracks/2/pick", json={"id": 5}).status_code == 409
    assert world.client.post(f"/api/sc2bp/jobs/{job_id}/tracks/2/pick", json={"id": "x"}).status_code == 422
    assert world.client.post(f"/api/sc2bp/jobs/{job_id}/tracks/99/pick", json={"id": None}).status_code == 404
    assert world.client.post(f"/api/sc2bp/jobs/{job_id}/apply").json()["job"]["state"] == "queued"
    world.runner.process_next()
    assert world.client.get(f"/api/sc2bp/jobs/{job_id}").json()["job"]["counts"]["added"] == 4
    assert world.client.post(f"/api/sc2bp/jobs/{job_id}/apply").json()["detail"] == "no new picks to add"


def test_a_manual_search_returns_the_updated_track(world):
    job_id = start(world)
    world.runner.process_next()
    world.bp.catalogue["my words"] = [
        {"id": 9, "title": "Song3", "mix": "Original Mix", "artists": ["Artist3"], "durationSec": 300}
    ]
    r = world.client.post(f"/api/sc2bp/jobs/{job_id}/tracks/3/search", json={"query": "my words"})
    assert r.status_code == 200 and r.json()["track"]["candidates"][0]["id"] == 9
    assert world.client.post(f"/api/sc2bp/jobs/{job_id}/tracks/3/search", json={"query": ""}).status_code == 422
    assert world.client.post(f"/api/sc2bp/jobs/{job_id}/tracks/3/search", json={"query": "x" * 201}).status_code == 422
    assert world.client.post(f"/api/sc2bp/jobs/{job_id}/tracks/4/search", json={"query": "x"}).status_code == 409


def test_beatport_trouble_during_a_manual_search_is_a_502_or_503(world):
    job_id = start(world)
    world.runner.process_next()
    world.bp.search_hook = lambda n: (_ for _ in ()).throw(transient("Beatport answered 503"))
    r = world.client.post(f"/api/sc2bp/jobs/{job_id}/tracks/3/search", json={"query": "x"})
    assert (r.status_code, r.json()["detail"]) == (502, "Beatport answered 503")
    world.bp.search_hook = lambda n: (_ for _ in ()).throw(BeatportError("not configured", fatal=True))
    assert world.client.post(f"/api/sc2bp/jobs/{job_id}/tracks/3/search", json={"query": "x"}).status_code == 503


def test_beatport_client_says_so_when_the_login_is_not_configured(monkeypatch):
    monkeypatch.delenv("BEATPORT_USERNAME", raising=False)
    monkeypatch.delenv("BEATPORT_PASSWORD", raising=False)
    service.beatport_client.cache_clear()
    with pytest.raises(BeatportError, match="not configured") as caught:
        service.beatport_client()
    assert caught.value.fatal


def test_the_real_app_starts_its_worker_and_finishes_a_job_with_nobody_watching(tmp_path, monkeypatch):
    import time

    sc, bp = FakeSoundCloud(), FakeBeatport()
    monkeypatch.setattr(service, "DATA_DIR", tmp_path)
    monkeypatch.setattr(service, "soundcloud", sc)
    monkeypatch.setattr(service, "beatport_client", lambda: bp)
    with TestClient(service.app) as client:  # runs the lifespan: the runner and its worker thread
        job_id = client.post("/api/sc2bp/jobs", json={"url": PLAYLIST}).json()["job"]["id"]
        deadline = time.time() + 15
        state = "queued"
        while state not in ("done", "failed") and time.time() < deadline:
            time.sleep(0.05)
            state = client.get(f"/api/sc2bp/jobs/{job_id}").json()["job"]["state"]
    assert state == "done" and bp.added == [1000, 1001, 1005]
    assert (tmp_path / "jobs" / f"{job_id}.json").exists()
