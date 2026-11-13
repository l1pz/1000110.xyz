import json
from datetime import datetime

import pytest
from errors import BadUrl, PlaylistError
from fakes import Crash
from sync_fakes import BUDAPEST, COOKIES, DAY, HOUSE, LIKED, NOON, SOURCE, TECHNO, World, transient, vid
from syncer import SyncError, latest_slot, video_id

@pytest.fixture
def world(tmp_path):
    return World(tmp_path)


def scenario_of(n, genre=TECHNO):
    return [("match", f"Artist{i} - Song{i}", genre) for i in range(n)]


# --- the first run -----------------------------------------------------------------------------------------------


def test_the_first_run_waits_for_a_yes_and_changes_nothing_on_beatport(world):
    run = world.run(confirm=False)
    assert run["state"] == "awaiting"
    assert world.bp.count("create_playlist") == 0 and world.bp.count("add_tracks") == 0
    preview = run["preview"]
    assert {g["name"]: g["add"] for g in preview["groups"]} == {"Techno": 3, "House & Melodic": 1, "Rock & Hip-Hop": 1}
    assert (preview["total"], preview["newPlaylists"], preview["review"], preview["notFound"]) == (5, 3, 1, 1)


def test_confirming_files_each_track_into_its_genre_playlist(world):
    run = world.run()
    assert run["state"] == "done" and run["counts"]["added"] == 5
    assert world.contents() == {
        "Liked - Techno #1": [2000, 2001, 2003],
        "Liked - House & Melodic #1": [2002],
        "Liked - Rock & Hip-Hop #1": [2006],
    }
    counts = world.syncer.status()["counts"]
    assert counts["onBeatport"] == 5 and counts["review"] == 1 and counts["notFound"] == 1 and counts["needYou"] == 1


def test_cancelling_at_the_preview_leaves_everything_alone(world):
    run = world.run(confirm=False)
    world.syncer.cancel_run(run["id"])
    assert world.syncer.get_run(run["id"])["state"] == "cancelled" and world.bp.count("add_tracks") == 0
    assert world.syncer.health()["configured"] is False


def test_a_first_run_with_nothing_to_file_needs_no_yes(tmp_path):
    w = World(tmp_path, [("none", "Artist0 - Song0", None)])
    assert w.run(confirm=False)["state"] == "done"


def test_only_one_run_goes_at_a_time(world):
    first, created = world.syncer.start_run()
    second, again = world.syncer.start_run()
    assert created and not again and first["id"] == second["id"]


# --- later runs --------------------------------------------------------------------------------------------------


def test_a_second_run_changes_nothing_and_searches_nothing(world):
    world.run()
    searches, adds, creates = (world.bp.count(n) for n in ("search", "add_tracks", "create_playlist"))
    again = world.run()
    assert again["state"] == "done" and again["counts"]["added"] == 0
    assert (world.bp.count("search"), world.bp.count("add_tracks"), world.bp.count("create_playlist")) == (searches, adds, creates)


def test_a_new_like_lands_in_the_right_playlist(tmp_path):
    scenario = [*LIKED, ("match", "Artist8 - Song8", TECHNO)]
    w = World(tmp_path, scenario, liked=8)
    w.run()
    w.yt.like(vid(8), "Artist8 - Song8")
    run = w.run()
    assert run["counts"]["newLikes"] == 1 and run["counts"]["added"] == 1
    assert w.contents()["Liked - Techno #1"] == [2000, 2001, 2003, 2008]
    assert w.bp.count("create_playlist") == 3  # no new playlist was needed


def test_a_full_playlist_overflows_into_the_next_number_oldest_likes_first(world):
    world.syncer.update_config({"cap": 2})
    world.run()
    assert world.contents()["Liked - Techno #1"] == [2001, 2003]  # the two oldest of the three
    assert world.contents()["Liked - Techno #2"] == [2000]


def test_later_likes_fill_the_last_playlist_before_starting_a_new_one(tmp_path):
    scenario = [("match", f"Artist{i} - Song{i}", TECHNO) for i in range(5)]
    w = World(tmp_path, scenario, liked=3)
    w.syncer.update_config({"cap": 2})
    w.run()
    assert [len(v) for v in w.contents().values()] == [2, 1]
    w.yt.like(vid(3), "Artist3 - Song3")
    w.yt.like(vid(4), "Artist4 - Song4")
    w.run()
    assert sorted(len(v) for v in w.contents().values()) == [1, 2, 2]  # #2 got one more, #3 holds the last
    assert sorted(w.contents()) == ["Liked - Techno #1", "Liked - Techno #2", "Liked - Techno #3"]


def test_an_unknown_genre_goes_to_the_catch_all_group(tmp_path):
    w = World(tmp_path, [("match", "Artist0 - Song0", "Polka")])
    w.run()
    assert list(w.contents()) == ["Liked - Other #1"]


def test_a_track_beatport_has_no_genre_for_goes_to_the_catch_all_group(tmp_path):
    w = World(tmp_path, [("match", "Artist0 - Song0", None)])
    w.run()
    assert list(w.contents()) == ["Liked - Other #1"]


# --- never removing, and respecting the owner --------------------------------------------------------------------


def test_an_unliked_song_stays_on_beatport_and_nothing_is_ever_removed(world):
    world.run()
    world.yt.unlike(vid(0))
    world.run()
    assert world.video(0)["liked"] is False and world.video(0)["filed"] is True
    assert 2000 in world.contents()["Liked - Techno #1"]
    assert world.syncer.status()["counts"]["unliked"] == 1
    assert {c[0] for c in world.bp.calls} <= {"search", "my_playlists", "playlist_tracks", "tracks_by_ids", "create_playlist", "add_tracks"}


def test_a_track_the_owner_takes_out_of_a_playlist_is_never_added_back(world):
    world.run()
    world.bp.remove(world.bp.by_name("Liked - Techno #1"), 2001)
    run = world.run()
    assert run["counts"]["dismissed"] == 1 and world.video(1)["dismissed"] is True
    adds = world.bp.count("add_tracks")
    world.run()
    world.run()
    assert 2001 not in world.contents()["Liked - Techno #1"] and world.bp.count("add_tracks") == adds


def test_a_dismissed_track_the_owner_puts_back_by_hand_counts_as_filed_again(world):
    world.run()
    pid = world.bp.by_name("Liked - Techno #1")
    world.bp.remove(pid, 2001)
    world.run()
    world.bp.items[pid].append(2001)
    world.run()
    assert world.video(1)["filed"] is True and world.video(1)["dismissed"] is False


# --- Beatport's answer is not the truth --------------------------------------------------------------------------


def test_a_track_the_add_call_accepts_but_beatport_drops_is_unavailable_not_filed(world):
    world.bp.reject = {2003}
    run = world.run()
    assert run["counts"]["unavailable"] == 1
    assert world.video(3)["status"] == "unavailable" and world.video(3)["filed"] is False
    assert 2003 not in world.contents()["Liked - Techno #1"]
    assert world.syncer.status()["counts"]["unavailable"] == 1


def test_a_track_the_add_answer_hides_but_beatport_kept_is_filed(world):
    world.bp.hide = {2001}
    world.run()
    assert world.video(1)["filed"] is True and world.video(1)["status"] == "matched"
    assert 2001 in world.contents()["Liked - Techno #1"]


def test_an_unavailable_track_is_tried_again_later_and_then_filed(world):
    world.bp.reject = {2003}
    world.run()
    world.later(31)
    world.bp.reject = set()
    world.run()
    assert world.video(3)["filed"] is True and 2003 in world.contents()["Liked - Techno #1"]


def test_an_unavailable_track_is_given_up_on_after_three_tries(world):
    world.bp.reject = {2003}
    world.run()
    for _ in range(5):
        world.later(31)
        world.run()
    tries = sum(1 for c in world.bp.calls if c[0] == "add_tracks" and 2003 in c[2])
    assert tries == 3 and world.video(3)["status"] == "unavailable"


# --- surviving a lost or confused state --------------------------------------------------------------------------


def test_lost_state_is_rebuilt_from_beatport_without_adding_anything_twice(world):
    world.run()
    adds, creates = world.bp.count("add_tracks"), world.bp.count("create_playlist")
    (world.dir / "sync" / "state.json").unlink()
    world.syncer = world.start()
    run = world.run()
    assert run["state"] == "done"
    assert (world.bp.count("add_tracks"), world.bp.count("create_playlist")) == (adds, creates)
    assert world.syncer.status()["counts"]["onBeatport"] == 5
    assert [p["name"] for g in world.syncer.status()["groups"] for p in g["playlists"]] == [
        "Liked - Techno #1",
        "Liked - House & Melodic #1",
        "Liked - Rock & Hip-Hop #1",
    ]


def test_a_crash_mid_filing_resumes_without_duplicates_or_extra_playlists(tmp_path):
    w = World(tmp_path, scenario_of(3))
    w.syncer.update_config({"cap": 1})

    def die(n):
        if n == 2:
            raise Crash

    w.bp.add_hook = die
    run, _ = w.syncer.start_run()
    w.syncer.process_next()
    w.syncer.confirm_run(run["id"])
    with pytest.raises(Crash):
        w.syncer.process_next()
    w.bp.add_hook = None
    w.syncer = w.start()
    w.syncer.process_next()
    assert w.syncer.get_run(run["id"])["state"] == "done"
    assert sorted(w.contents().values()) == [[2000], [2001], [2002]]
    assert w.bp.count("create_playlist") == 3


def test_a_playlist_that_vanished_is_a_decision_not_an_automatic_refile(world):
    world.run()
    adds, creates = world.bp.count("add_tracks"), world.bp.count("create_playlist")
    gone = world.bp.by_name("Liked - Techno #1")
    world.bp.delete_playlist(gone)
    world.run()
    assert (world.bp.count("add_tracks"), world.bp.count("create_playlist")) == (adds, creates)
    assert world.syncer.status()["counts"]["gone"] == 1
    [row] = world.syncer.inbox("gone")["playlists"]
    assert row["id"] == gone and row["tracks"] == 3
    assert all(world.video(i)["held"] == "gone" for i in (0, 1, 3))


def test_recreating_a_vanished_playlist_files_its_tracks_again(world):
    world.run()
    gone = world.bp.by_name("Liked - Techno #1")
    world.bp.delete_playlist(gone)
    world.run()
    world.syncer.resolve_gone(gone, "recreate")
    world.run()
    assert world.contents()["Liked - Techno #1"] == [2000, 2001, 2003]
    assert world.syncer.status()["counts"]["gone"] == 0


def test_forgetting_a_vanished_playlist_leaves_its_tracks_out(world):
    world.run()
    gone = world.bp.by_name("Liked - Techno #1")
    world.bp.delete_playlist(gone)
    world.run()
    world.syncer.resolve_gone(gone, "forget")
    world.run()
    assert "Liked - Techno #1" not in world.contents()
    assert all(world.video(i)["dismissed"] for i in (0, 1, 3))


def test_a_state_file_that_cannot_be_read_stops_the_sync_and_is_left_alone(tmp_path):
    (tmp_path / "sync").mkdir()
    (tmp_path / "sync" / "state.json").write_text("{ not json", encoding="utf-8")
    w = World(tmp_path)
    assert w.syncer.broken
    with pytest.raises(SyncError, match="could not be read"):
        w.syncer.start_run()
    assert w.syncer.health()["status"] == "broken" and w.syncer.health()["ok"] is False
    assert (tmp_path / "sync" / "state.json").read_text(encoding="utf-8") == "{ not json"


# --- guards ------------------------------------------------------------------------------------------------------


def test_a_listing_far_smaller_than_the_known_likes_is_refused_and_changes_nothing(tmp_path):
    w = World(tmp_path, scenario_of(30))
    w.run()
    w.yt.entries = w.yt.entries[:5]
    run = w.run()
    assert run["state"] == "failed" and "looks wrong" in run["error"]["message"]
    assert sum(1 for v in w.syncer._state["videos"].values() if v["liked"]) == 30


def test_an_empty_listing_is_refused(world):
    world.run()
    world.yt.entries = []
    run = world.run()
    assert run["state"] == "failed" and "no liked songs" in run["error"]["message"]
    assert all(v["liked"] for v in world.syncer._state["videos"].values())


def test_expired_cookies_fail_the_run_and_the_health_says_so(world):
    world.run()
    world.yt.error = COOKIES
    run = world.run()
    assert run["state"] == "failed" and run["error"]["kind"] == "cookies"
    health = world.syncer.health()
    assert health["ok"] is False and health["status"] == "needs-cookies"
    world.yt.error = None
    world.run()
    assert world.syncer.health()["ok"] is True


def test_a_rate_limit_is_waited_out_then_the_run_goes_on(world):
    failures = {"n": 2}
    real = world.bp.my_playlists

    def flaky():
        if failures["n"]:
            failures["n"] -= 1
            raise transient("Beatport answered 429")
        return real()

    world.bp.my_playlists = flaky
    run = world.run()
    assert run["state"] == "done" and world.clock.now > NOON  # it slept 5 s and 15 s


def test_a_beatport_outage_that_lasts_fails_the_run_with_a_reason(world):
    world.bp.search_error = transient("Beatport answered 503")
    run = world.run()
    assert run["state"] == "failed" and "503" in run["error"]["message"] and run["error"]["retryable"] is True


def test_a_cancel_during_matching_stops_the_run(world):
    run, _ = world.syncer.start_run()
    world.bp.search_hook = lambda n: world.syncer.cancel_run(run["id"]) if n == 2 else None
    world.syncer.process_next()
    assert world.syncer.get_run(run["id"])["state"] == "cancelled"
    assert world.bp.count("create_playlist") == 0


# --- the inbox ---------------------------------------------------------------------------------------------------


def test_the_inbox_lists_what_needs_a_decision(world):
    world.run()
    [row] = world.syncer.inbox("review")["videos"]
    assert row["id"] == vid(4) and row["label"] == "Artist4 - Song4" and row["candidates"][0]["id"] == 2004
    [nf] = world.syncer.inbox("notfound")["videos"]
    assert nf["id"] == vid(5)
    with pytest.raises(SyncError):
        world.syncer.inbox("nonsense")


def test_picking_a_suggestion_files_it_on_the_next_run(world):
    world.run()
    row = world.syncer.pick(vid(4), 2004)
    assert row["status"] == "matched" and row["genre"] == HOUSE and row["group"] == "house-melodic"
    world.run()
    assert 2004 in world.contents()["Liked - House & Melodic #1"] and world.video(4)["filed"] is True


def test_a_pick_can_be_undone_and_must_be_one_of_the_suggestions(world):
    world.run()
    world.syncer.pick(vid(4), 2004)
    assert world.syncer.pick(vid(4), None)["status"] == "review"
    with pytest.raises(SyncError, match="suggestions"):
        world.syncer.pick(vid(4), 999)
    with pytest.raises(KeyError):
        world.syncer.pick("nope", None)


def test_a_filed_track_cannot_be_changed_from_the_inbox(world):
    world.run()
    for call in (lambda: world.syncer.pick(vid(0), None), lambda: world.syncer.skip(vid(0)), lambda: world.syncer.set_group(vid(0), "bass")):
        with pytest.raises(SyncError, match="already in a Beatport playlist"):
            call()


def test_searching_by_hand_offers_new_suggestions(world):
    world.run()
    world.bp.catalogue["better query"] = [2004]
    row = world.syncer.search_video(vid(5), "better query")
    assert row["status"] == "review" and row["candidates"][0]["id"] == 2004 and row["query"] == "better query"
    with pytest.raises(SyncError):
        world.syncer.search_video(vid(5), "  ")


def test_a_skipped_track_is_never_searched_again_until_restored(world):
    world.run()
    world.syncer.skip(vid(5))
    searches = world.bp.count("search")
    world.later(40)
    world.run()
    assert world.bp.count("search") == searches and world.video(5)["status"] == "skipped"
    world.syncer.restore(vid(5))
    world.run()
    assert world.bp.count("search") == searches + 1


def test_a_group_override_files_one_track_elsewhere(world):
    world.run()
    world.syncer.pick(vid(4), 2004)
    assert world.syncer.set_group(vid(4), "techno")["group"] == "techno"
    world.run()
    assert 2004 in world.contents()["Liked - Techno #1"]
    with pytest.raises(SyncError, match="unknown group"):
        world.syncer.set_group(vid(6), "nope")


def test_a_track_not_found_is_looked_for_again_after_two_weeks_when_it_appears(world):
    world.run()
    searches = world.bp.count("search")
    world.later(10)
    world.run()
    assert world.bp.count("search") == searches  # not yet due
    world.bp.tracks[2005] = {"id": 2005, "title": "Song5", "mix": "Original Mix", "artists": ["Artist5"], "durationSec": 300, "genre": TECHNO, "subGenre": None}
    world.bp.catalogue["Artist5 Song5"] = [2005]
    world.later(5)
    world.run()
    assert world.video(5)["status"] == "matched" and world.video(5)["filed"] is True
    assert 2005 in world.contents()["Liked - Techno #1"]


def test_a_track_never_found_is_looked_for_three_times_in_all(world):
    world.run()
    for _ in range(6):
        world.later(15)
        world.run()
    assert sum(1 for c in world.bp.calls if c == ("search", "Artist5 Song5")) == 3


# --- the nightly schedule ----------------------------------------------------------------------------------------


def test_the_latest_slot_is_today_or_yesterday_in_the_owners_time_zone():
    noon = datetime(2026, 11, 13, 12, 0, tzinfo=BUDAPEST).timestamp()
    three = datetime(2026, 11, 13, 3, 0, tzinfo=BUDAPEST).timestamp()
    assert latest_slot(noon, 4, 30, "Europe/Budapest") == datetime(2026, 11, 13, 4, 30, tzinfo=BUDAPEST).timestamp()
    assert latest_slot(three, 4, 30, "Europe/Budapest") == datetime(2026, 11, 12, 4, 30, tzinfo=BUDAPEST).timestamp()


def enable_nightly(w):
    w.syncer.update_config({"nightly": {"enabled": True}})


def test_nothing_runs_by_itself_before_the_first_good_run_or_when_switched_off(world):
    enable_nightly(world)
    assert world.syncer.tick(force=True) is False  # no good run yet
    world.run()
    world.syncer.update_config({"nightly": {"enabled": False}})
    world.later(2)
    assert world.syncer.tick(force=True) is False


def test_a_good_run_counts_as_todays_sync_so_no_second_one_follows(world):
    enable_nightly(world)
    world.run()
    assert world.syncer.tick(force=True) is False


def test_the_nightly_run_starts_once_when_its_time_comes(world):
    enable_nightly(world)
    world.run()
    world.later(1)  # next day, 12:00: the 04:30 slot has passed
    assert world.syncer.tick(force=True) is True
    assert world.syncer.tick(force=True) is False  # one is already going
    world.syncer.process_next()
    assert world.syncer.tick(force=True) is False  # and today's is done
    assert world.syncer.runs()[0]["kind"] == "auto"


def test_after_days_of_downtime_one_catch_up_run_starts(world):
    enable_nightly(world)
    world.run()
    world.later(4)
    assert world.syncer.tick(force=True) is True
    world.syncer.process_next()
    assert world.syncer.tick(force=True) is False


def test_a_failed_nightly_run_is_retried_once_after_six_hours_not_in_a_loop(world):
    enable_nightly(world)
    world.run()
    world.later(1)
    world.yt.error = PlaylistError("reading the playlist took too long", retryable=True)
    world.syncer.tick(force=True)
    world.syncer.process_next()
    assert world.syncer.runs()[0]["state"] == "failed"
    world.clock.now += 3600
    assert world.syncer.tick(force=True) is False
    world.clock.now += 6 * 3600
    world.yt.error = None
    assert world.syncer.tick(force=True) is True
    world.syncer.process_next()
    assert world.syncer.runs()[0]["state"] == "done"


def test_expired_cookies_are_not_retried_in_a_loop(world):
    enable_nightly(world)
    world.run()
    world.later(1)
    world.yt.error = COOKIES
    world.syncer.tick(force=True)
    world.syncer.process_next()
    world.clock.now += 7 * 3600
    assert world.syncer.tick(force=True) is False


def test_a_stale_sync_makes_the_health_fail(world):
    enable_nightly(world)
    world.run()
    assert world.syncer.health()["ok"] is True
    world.clock.now += 37 * 3600
    assert world.syncer.health()["status"] == "stale"


def test_a_restarted_server_carries_on_a_run_that_was_going(world):
    run, _ = world.syncer.start_run()
    world.syncer._claim(timeout=0)  # it was running when the server died
    restarted = world.start()
    assert restarted.get_run(run["id"])["state"] == "queued"


# --- configuration -----------------------------------------------------------------------------------------------


def test_config_changes_are_validated_saved_and_survive_a_restart(world):
    world.syncer.update_config({"cap": 50, "prefix": "Mine", "nightly": {"enabled": True, "hour": 3}})
    again = world.start().config()
    assert (again["cap"], again["prefix"], again["nightly"]["enabled"], again["nightly"]["hour"]) == (50, "Mine", True, 3)
    assert again["nightly"]["minute"] == 30


@pytest.mark.parametrize(
    "patch",
    [
        {"cap": 0},
        {"cap": 2001},
        {"cap": True},
        {"prefix": ""},
        {"prefix": "a#b"},
        {"nightly": {"hour": 24}},
        {"nightly": {"tz": "Mars/Base"}},
        {"source": "https://evil.example/x"},
        {"source": "https://www.youtube.com/watch?v=abc"},
        {"groups": []},
        {"groups": [{"id": "a", "name": "A", "genres": ["House"]}, {"id": "b", "name": "B", "genres": ["House"]}]},
        {"groups": [{"id": "other", "name": "A", "genres": []}]},
        {"groups": [{"id": "a", "name": "A", "genres": []}, {"id": "b", "name": "a", "genres": []}]},
    ],
)
def test_bad_config_is_refused(world, patch):
    with pytest.raises(SyncError):
        world.syncer.update_config(patch)


def test_groups_can_be_edited_until_they_have_playlists_and_genres_can_always_move(world):
    config = world.syncer.config()
    groups = config["groups"]
    groups[0]["genres"].remove("Hard Techno")
    groups[1]["genres"].append("Hard Techno")
    world.syncer.update_config({"groups": groups})
    world.run()
    renamed = world.syncer.config()["groups"]
    renamed[0]["name"] = "Techno!"
    with pytest.raises(SyncError, match="cannot be renamed"):
        world.syncer.update_config({"groups": renamed})
    with pytest.raises(SyncError, match="prefix"):
        world.syncer.update_config({"prefix": "New"})
    moved = world.syncer.config()["groups"]
    moved[0]["genres"].append("Something New")
    world.syncer.update_config({"groups": moved})
    assert "Something New" in world.syncer.config()["groups"][0]["genres"]


def test_a_group_with_playlists_cannot_be_removed(world):
    world.run()
    groups = [g for g in world.syncer.config()["groups"] if g["id"] != "techno"]
    with pytest.raises(SyncError, match="cannot be renamed or removed"):
        world.syncer.update_config({"groups": groups})


# --- importing a finished conversion -----------------------------------------------------------------------------


def write_job(tmp_path, **over):
    (tmp_path / "jobs").mkdir(exist_ok=True)
    cand = lambda i: [{"id": 2000 + i, "title": f"Song{i}", "mix": "Original Mix", "artists": [f"Artist{i}"], "durationSec": 300, "score": 1}]  # noqa: E731
    track = lambda i, **kw: {"url": f"https://www.youtube.com/watch?v={vid(i)}", "title": f"Artist{i} - Song{i}", "uploader": "Up", "durationSec": 300.0, "uploaderIsArtist": False, "state": "matched", "verdict": "match", "query": f"Artist{i} Song{i}", "candidates": cand(i), "picked": 2000 + i, **kw}  # noqa: E731
    job = {
        "id": "6aad4181",
        "url": SOURCE,
        "source": "youtube",
        "tracks": [
            track(0),
            track(1, picked=None, error="Beatport would not add this track to the playlist"),  # a mislabelled "refused"
            track(2, state="unreadable", verdict=None, candidates=[], picked=None, title=""),
            track(3, verdict="maybe", picked=None),
            track(4, verdict="none", picked=None, candidates=[]),
        ],
        **over,
    }
    (tmp_path / "jobs" / "6aad4181.json").write_text(json.dumps(job), encoding="utf-8")


def test_importing_a_conversion_reuses_its_matches_and_picks(tmp_path):
    write_job(tmp_path)
    w = World(tmp_path)
    assert w.syncer.import_job("6aad4181") == {"imported": 5, "total": 5}
    statuses = [w.video(i)["status"] for i in range(5)]
    assert statuses == ["matched", "matched", "unreadable", "review", "notfound"]
    assert w.video(1)["picked"] == 2001  # the add call's refusal was not believed
    assert w.syncer.import_job("6aad4181") == {"imported": 0, "total": 5}  # twice is harmless


def test_a_run_after_an_import_only_searches_what_was_not_imported(tmp_path):
    write_job(tmp_path)
    w = World(tmp_path)
    w.syncer.import_job("6aad4181")
    run = w.run()
    searched = [c[1] for c in w.bp.calls if c[0] == "search"]
    # v0 to v4 were imported; v2 was unreadable then but YouTube shows it now, so it is read and searched; v7 is blank
    assert sorted(searched) == ["Artist2 Song2", "Artist5 Song5", "Artist6 Song6"]
    assert w.bp.count("tracks_by_ids") >= 1  # the imported picks had no genre yet
    assert w.contents()["Liked - Techno #1"] == [2000, 2001]
    assert run["state"] == "done"


def test_importing_the_wrong_conversion_is_refused(tmp_path):
    write_job(tmp_path, url="https://www.youtube.com/playlist?list=PLother")
    w = World(tmp_path)
    with pytest.raises(SyncError, match="different playlist"):
        w.syncer.import_job("6aad4181")
    with pytest.raises(KeyError):
        w.syncer.import_job("deadbeef")
    with pytest.raises(KeyError):
        w.syncer.import_job("../../etc")


def test_video_ids_come_from_watch_links_only():
    assert video_id("https://music.youtube.com/watch?v=abc_123-x") == "abc_123-x"
    assert video_id("https://www.youtube.com/watch?v=a&v=b") is None
    assert video_id("https://www.youtube.com/playlist?list=LM") is None
    assert video_id("https://www.youtube.com/watch?v=" + "x" * 40) is None


def test_the_source_must_be_a_youtube_playlist_link(world):
    with pytest.raises(BadUrl):
        world.yt.check_url("https://evil.example/")


# --- found in review ---------------------------------------------------------------------------------------------


def test_the_sync_reads_far_more_likes_than_a_conversion_may(world):
    import syncer as syncer_module

    world.run()
    assert world.yt.max_tracks == syncer_module.MAX_LIKES and syncer_module.MAX_LIKES >= 5000


def test_a_stale_read_right_after_an_add_does_not_make_good_tracks_unavailable(world):
    world.bp.lag = True
    run = world.run()
    assert run["counts"]["unavailable"] == 0 and run["counts"]["added"] == 5
    assert all(world.video(i)["filed"] for i in (0, 1, 2, 3, 6))


def test_a_song_unliked_before_it_was_filed_is_left_alone(tmp_path):
    write_job(tmp_path)
    w = World(tmp_path)
    w.syncer.import_job("6aad4181")
    w.yt.unlike(vid(1))  # imported as a pick, but no longer liked
    w.run()
    assert 2001 not in w.contents().get("Liked - Techno #1", [])
    assert w.video(1)["liked"] is False and w.video(1)["filed"] is False


def test_a_run_reports_how_far_it_is_inside_the_current_phase(world):
    run, _ = world.syncer.start_run()
    searching, filing = [], []
    view = lambda: world.syncer.get_run(run["id"])  # noqa: E731
    world.bp.search_hook = lambda n: searching.append((view()["phase"], view()["progress"]))
    world.bp.add_hook = lambda n: filing.append((view()["phase"], view()["progress"]))
    world.syncer.process_next()
    world.syncer.confirm_run(run["id"])
    world.syncer.process_next()
    assert searching[0] == ("match", {"done": 0, "total": 7}) and searching[-1][1] == {"done": 6, "total": 7}
    assert filing[0] == ("file", {"done": 0, "total": 5})
    assert [p["done"] for _, p in filing] == sorted(p["done"] for _, p in filing)  # it only moves forward
    assert view()["state"] == "done" and view()["progress"] is None  # finished: nothing left to count


def test_genres_no_group_lists_are_reported_so_they_can_be_moved(tmp_path):
    w = World(tmp_path, [("match", "Artist0 - Song0", "Polka"), ("match", "Artist1 - Song1", "Polka"), ("match", "Artist2 - Song2", TECHNO)])
    w.run()
    assert w.syncer.status()["otherGenres"] == {"Polka": 2}
    groups = w.syncer.config()["groups"]
    groups[0]["genres"].append("Polka")
    w.syncer.update_config({"groups": groups})
    assert w.syncer.status()["otherGenres"] == {}
