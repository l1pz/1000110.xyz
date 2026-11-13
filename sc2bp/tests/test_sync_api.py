import app as service
import pytest
from beatport import BeatportError
from fastapi.testclient import TestClient
from sync_fakes import COOKIES, World, vid
from test_syncer import write_job

BASE = "/api/sc2bp/sync"


@pytest.fixture
def world(tmp_path):
    w = World(tmp_path)
    service.app.state.syncer = w.syncer
    w.client = TestClient(service.app)
    yield w
    del service.app.state.syncer


def finish(world, confirm=True):
    """Start a run over HTTP and let the worker do it, like the real thread would."""
    run = world.client.post(f"{BASE}/run").json()["run"]
    world.syncer.process_next()
    if confirm and world.syncer.get_run(run["id"])["state"] == "awaiting":
        assert world.client.post(f"{BASE}/run/{run['id']}/confirm").status_code == 200
        world.syncer.process_next()
    return run["id"]


def test_the_status_has_everything_the_home_page_needs(world):
    body = world.client.get(BASE).json()
    assert {"config", "health", "run", "counts", "groups", "lastSuccess", "nextAuto", "confirmedOnce"} <= body.keys()
    assert body["run"] is None and body["health"]["configured"] is False
    assert [g["id"] for g in body["groups"]][0] == "techno"


def test_starting_a_run_twice_gives_the_same_run_back(world):
    first = world.client.post(f"{BASE}/run").json()
    again = world.client.post(f"{BASE}/run").json()
    assert first["created"] is True and again["created"] is False and first["run"]["id"] == again["run"]["id"]


def test_the_first_run_shows_a_preview_and_waits_for_a_yes(world):
    run_id = finish(world, confirm=False)
    run = world.client.get(f"{BASE}/runs/{run_id}").json()["run"]
    assert run["state"] == "awaiting" and run["preview"]["total"] == 5
    assert world.client.post(f"{BASE}/run/{run_id}/confirm").json()["run"]["state"] == "queued"
    assert world.client.post(f"{BASE}/run/{run_id}/confirm").status_code == 409  # no longer waiting
    world.syncer.process_next()
    assert world.client.get(f"{BASE}/runs").json()["runs"][0]["state"] == "done"


def test_unknown_or_malformed_run_ids_are_404(world):
    for rid in ("deadbeef", "../x", "ZZZZZZZZ"):
        assert world.client.get(f"{BASE}/runs/{rid}").status_code == 404
        assert world.client.post(f"{BASE}/run/{rid}/cancel").status_code == 404


def test_a_run_can_be_cancelled_before_it_starts(world):
    run_id = world.client.post(f"{BASE}/run").json()["run"]["id"]
    assert world.client.post(f"{BASE}/run/{run_id}/cancel").json()["run"]["state"] == "cancelled"
    assert world.client.post(f"{BASE}/run/{run_id}/cancel").status_code == 409


def test_health_is_200_until_set_up_then_503_when_the_owner_has_to_act(world):
    ok = world.client.get(f"{BASE}/health")
    assert ok.status_code == 200 and ok.json()["configured"] is False
    finish(world)
    assert world.client.get(f"{BASE}/health").json()["status"] == "ok"
    world.yt.error = COOKIES
    finish(world)
    bad = world.client.get(f"{BASE}/health")
    assert bad.status_code == 503 and "cookies" in bad.json()["detail"]


def test_the_inbox_pages_and_validates_its_filter(world):
    finish(world)
    body = world.client.get(f"{BASE}/inbox").json()
    assert body["total"] == 1 and body["videos"][0]["id"] == vid(4)
    assert world.client.get(f"{BASE}/inbox", params={"filter": "nope"}).status_code == 400
    assert world.client.get(f"{BASE}/inbox", params={"limit": 101}).status_code == 422
    assert world.client.get(f"{BASE}/inbox", params={"filter": "notfound"}).json()["videos"][0]["id"] == vid(5)


def test_deciding_about_a_track_over_http(world):
    finish(world)
    v = f"{BASE}/videos/{vid(4)}"
    assert world.client.post(f"{v}/pick", json={"id": 2004}).json()["track"]["status"] == "matched"
    assert world.client.post(f"{v}/pick", json={"id": 999}).status_code == 409
    assert world.client.post(f"{v}/group", json={"group": "techno"}).json()["track"]["group"] == "techno"
    assert world.client.post(f"{v}/group", json={"group": None}).json()["track"]["group"] == "house-melodic"
    assert world.client.post(f"{BASE}/videos/{vid(5)}/skip").json()["track"]["status"] == "skipped"
    assert world.client.post(f"{BASE}/videos/{vid(5)}/restore").json()["track"]["status"] == "new"
    assert world.client.post(f"{BASE}/videos/nope/skip").status_code == 404
    assert world.client.post(f"{v}/search", json={"query": ""}).status_code == 422


def test_a_search_that_beatport_refuses_says_so(world):
    finish(world)
    world.bp.search_error = BeatportError("the Beatport login was refused", fatal=True)
    assert world.client.post(f"{BASE}/videos/{vid(4)}/search", json={"query": "x"}).status_code == 503
    world.bp.search_error = BeatportError("Beatport answered 502", retryable=True)
    assert world.client.post(f"{BASE}/videos/{vid(4)}/search", json={"query": "x"}).status_code == 502


def test_config_is_changed_and_validated_over_http(world):
    ok = world.client.put(f"{BASE}/config", json={"cap": 50, "nightly": {"enabled": True, "hour": 3}})
    assert ok.status_code == 200 and ok.json()["config"]["cap"] == 50 and ok.json()["config"]["nightly"]["hour"] == 3
    assert world.client.put(f"{BASE}/config", json={"cap": 0}).status_code == 400
    assert world.client.put(f"{BASE}/config", json={"nightly": {"tz": "Mars/Base"}}).status_code == 400
    assert world.client.put(f"{BASE}/config", json={"prefix": "x" * 41}).status_code == 422
    groups = [{"id": "all", "name": "Everything", "genres": ["House", "Techno (Peak Time / Driving)"]}]
    assert world.client.put(f"{BASE}/config", json={"groups": groups}).json()["config"]["groups"][0]["id"] == "all"


def test_importing_a_conversion_over_http(world, tmp_path):
    write_job(tmp_path)
    assert world.client.post(f"{BASE}/import-job", json={"jobId": "6aad4181"}).json()["imported"] == 5
    assert world.client.post(f"{BASE}/import-job", json={"jobId": "deadbeef"}).status_code == 404
    assert world.client.post(f"{BASE}/import-job", json={"jobId": "x" * 20}).status_code == 422


def test_a_vanished_playlist_is_resolved_over_http(world):
    finish(world)
    gone = world.bp.by_name("Liked - Techno #1")
    world.bp.delete_playlist(gone)
    finish(world)
    assert world.client.get(f"{BASE}/inbox", params={"filter": "gone"}).json()["total"] == 1
    assert world.client.post(f"{BASE}/gone", json={"playlistId": gone, "action": "explode"}).status_code == 409
    assert world.client.post(f"{BASE}/gone", json={"playlistId": 1, "action": "forget"}).status_code == 404
    assert world.client.post(f"{BASE}/gone", json={"playlistId": gone, "action": "forget"}).json() == {"ok": True}


def test_a_broken_state_file_turns_into_clear_answers_not_crashes(tmp_path):
    (tmp_path / "sync").mkdir()
    (tmp_path / "sync" / "state.json").write_text("nope", encoding="utf-8")
    w = World(tmp_path)
    service.app.state.syncer = w.syncer
    try:
        client = TestClient(service.app)
        assert client.post(f"{BASE}/run").status_code == 409
        assert client.get(f"{BASE}/health").status_code == 503
        assert client.get(BASE).json()["health"]["status"] == "broken"
    finally:
        del service.app.state.syncer
