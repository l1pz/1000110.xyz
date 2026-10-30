import json

import jobs
import pytest
from beatport import BeatportError
from fakes import PLAYLIST, SCENARIO, Clock, Crash, FakeBeatport, FakeSoundCloud, transient
from jobs import JobError, Runner
from soundcloud import BadUrl, PlaylistError


class World:
    def __init__(self, tmp_path, scenario=SCENARIO):
        self.dir = tmp_path
        self.sc = FakeSoundCloud(scenario)
        self.bp = FakeBeatport(scenario)
        self.clock = Clock()
        self.runner = self.start()

    def start(self):
        """A new server process on the same data directory."""
        return Runner(self.dir, self.sc, lambda: self.bp, sleep=self.clock.sleep, clock=self.clock)

    def run(self, link=PLAYLIST, name=""):
        job, _ = self.runner.submit(link, name)
        self.runner.process_next()
        return self.runner.get(job["id"])


@pytest.fixture
def world(tmp_path):
    return World(tmp_path)


def test_a_job_lists_reads_matches_and_creates_the_playlist(world):
    job = world.run()
    assert job["state"] == "done" and job["phase"] == "finished" and job["error"] is None
    assert job["name"] == "My set"
    assert job["counts"] == {"match": 3, "maybe": 2, "none": 2, "error": 0, "unreadable": 1, "picked": 3, "added": 3}
    assert job["needsReview"] == 4  # the two maybes and the two nones; the unreadable one is not a match problem
    assert world.bp.created == ["My set"]
    assert world.bp.added == [1000, 1001, 1005]
    assert job["playlist"] == {"id": 77, "url": "https://www.beatport.com/library/playlists/77", "name": "My set"}


def test_the_name_given_wins_over_soundclouds(world):
    assert world.run(name="  Friday mix ")["name"] == "Friday mix"
    assert world.bp.created == ["Friday mix"]


def test_an_unreadable_track_is_read_twice_before_it_is_given_up(world):
    world.run()
    assert sum(call.count("https://soundcloud.com/a/t4") for call in world.sc.read_calls) == 2


def test_a_blank_that_was_only_a_hiccup_is_read_on_the_second_pass(world):
    world.sc.blank_once = {"https://soundcloud.com/a/t0"}
    job = world.run()
    assert job["counts"]["match"] == 3 and job["counts"]["unreadable"] == 1


def test_a_link_already_being_converted_gives_the_same_job(world):
    first, created = world.runner.submit(PLAYLIST)
    again, created_again = world.runner.submit(PLAYLIST)
    assert (created, created_again, again["id"]) == (True, False, first["id"])


def test_a_finished_link_can_be_converted_again(world):
    first = world.run()
    second, created = world.runner.submit(PLAYLIST)
    assert created and second["id"] != first["id"]


def test_only_so_many_jobs_may_wait(world, monkeypatch):
    monkeypatch.setattr(jobs, "MAX_ACTIVE", 2)
    world.runner.submit("https://soundcloud.com/a/sets/1")
    world.runner.submit("https://soundcloud.com/a/sets/2")
    with pytest.raises(JobError, match="already waiting"):
        world.runner.submit("https://soundcloud.com/a/sets/3")


def test_a_link_that_is_not_soundcloud_is_refused(world):
    with pytest.raises(BadUrl):
        world.runner.submit("https://evil.example/x")


def test_jobs_are_listed_newest_first(world):
    world.run("https://soundcloud.com/a/sets/1")
    world.clock.now += 5
    world.run("https://soundcloud.com/a/sets/2")
    assert [j["url"][-1] for j in world.runner.list()] == ["2", "1"]


# --- crashes and restarts ------------------------------------------------------------------------------------


def test_a_crash_while_matching_resumes_without_redoing_work(world, monkeypatch):
    monkeypatch.setattr(jobs, "SAVE_EVERY", 1)

    def die(n):
        if n == 4:
            raise Crash

    world.bp.search_hook = die
    world.runner.submit(PLAYLIST)
    with pytest.raises(Crash):
        world.runner.process_next()
    reads_before = len(world.sc.read_calls)

    world.bp.search_hook = None
    restarted = world.start()
    [job] = restarted.list()
    assert job["state"] == "queued"  # was "running" when the server died
    restarted.process_next()
    job = restarted.get(job["id"])
    assert job["state"] == "done" and job["counts"]["match"] == 3
    assert len(world.sc.read_calls) == reads_before and world.sc.list_calls == 1
    assert len(world.bp.queries) == len(set(world.bp.queries)) + 1  # only the search that was cut off ran twice


def test_the_playlist_is_never_made_twice_after_a_crash_between_batches(world, monkeypatch):
    monkeypatch.setattr(jobs, "ADD_BATCH", 1)

    def die(n):
        if n == 2:
            raise Crash

    world.bp.add_hook = die
    world.runner.submit(PLAYLIST)
    with pytest.raises(Crash):
        world.runner.process_next()
    assert world.bp.created == ["My set"] and world.bp.added == [1000]

    world.bp.add_hook = None
    restarted = world.start()
    restarted.process_next()
    assert world.bp.created == ["My set"]  # still one
    assert world.bp.added == [1000, 1001, 1005]  # and no track added twice


def test_a_crash_loses_at_most_the_searches_since_the_last_save(world):
    """With the real settings (a save every 5 searches), searches 1-5 are saved and the crash in the 7th loses 6."""

    def die(n):
        if n == 7:
            raise Crash

    world.bp.search_hook = die
    world.runner.submit(PLAYLIST)
    with pytest.raises(Crash):
        world.runner.process_next()
    world.bp.search_hook = None
    restarted = world.start()
    restarted.process_next()
    assert restarted.list()[0]["state"] == "done"
    redone = len(world.bp.queries) - len(set(world.bp.queries))
    assert 0 < redone <= jobs.SAVE_EVERY


def test_the_save_is_also_timed_so_slow_searches_are_not_lost(world):
    def slow(n):
        world.clock.now += 3  # each search takes longer than SAVE_SECS
        if n == 4:
            raise Crash

    world.bp.search_hook = slow
    world.runner.submit(PLAYLIST)
    with pytest.raises(Crash):
        world.runner.process_next()
    world.bp.search_hook = None
    world.start().process_next()
    assert len(world.bp.queries) - len(set(world.bp.queries)) == 1  # only the cut-off search


def test_a_job_file_that_is_damaged_is_skipped_not_fatal(world, tmp_path):
    world.run()
    (tmp_path / "jobs" / "deadbeef.json").write_text("{not json")
    (tmp_path / "jobs" / "abcd1234.json").write_text(json.dumps({"id": "../../etc", "tracks": [], "state": "done"}))
    assert len(world.start().list()) == 1


# --- errors --------------------------------------------------------------------------------------------------


def test_a_search_that_fails_a_few_times_is_retried_after_a_growing_wait(world):
    def flaky(n):
        if n <= 2:
            raise transient()

    world.bp.search_hook = flaky
    job = world.run()
    assert job["state"] == "done" and job["counts"]["error"] == 0
    assert world.clock.slept >= 5 + 15


def test_beatports_own_wait_is_respected(world):
    def limited(n):
        if n == 1:
            raise BeatportError("Beatport answered 429", retryable=True, retry_after=90)

    world.bp.search_hook = limited
    assert world.run()["state"] == "done"
    assert world.clock.slept >= 90


def test_the_countdown_is_visible_while_waiting(world):
    seen = []

    def flaky(n):
        if n == 1:
            raise transient("Beatport answered 503")
        job = world.runner.list()[0]
        seen.append(job["waiting"])

    world.bp.search_hook = flaky
    world.run()
    assert seen[0] is None  # waiting is cleared once the wait is over
    saved = json.loads(next((world.dir / "jobs").glob("*.json")).read_text())
    assert saved["waiting"] is None


def test_three_tracks_failing_in_a_row_pause_the_job_and_retry_carries_on(world):
    world.bp.search_hook = lambda n: (_ for _ in ()).throw(transient())
    job = world.run()
    assert job["state"] == "paused"
    assert "keeps failing" in job["error"]["message"] and job["error"]["phase"] == "matching"
    assert job["counts"]["error"] == 3

    world.bp.search_hook = None
    world.runner.retry(job["id"])
    world.runner.process_next()
    job = world.runner.get(job["id"])
    assert job["state"] == "done" and job["counts"]["error"] == 0 and job["counts"]["match"] == 3


def test_one_odd_track_error_does_not_pause_the_job(world):
    def odd(n):
        if n == 2:
            raise BeatportError("Beatport answered 400 for GET /catalog/search")

    world.bp.search_hook = odd
    job = world.run()
    assert job["state"] == "done" and job["counts"]["error"] == 1
    assert job["needsReview"] == 5  # the failed one joins the four unmatched

    world.bp.search_hook = None
    world.runner.retry(job["id"])  # a finished job with errors can try just those again
    world.runner.process_next()
    assert world.runner.get(job["id"])["counts"]["error"] == 0


def test_a_refused_beatport_login_fails_the_job_with_the_reason(world):
    def refused(n):
        raise BeatportError("Beatport refused the login (wrong username or password?)", fatal=True)

    world.bp.search_hook = refused
    job = world.run()
    assert job["state"] == "failed" and "refused the login" in job["error"]["message"]
    assert job["counts"]["error"] == 0  # nothing was blamed on the tracks

    world.bp.search_hook = None
    world.runner.retry(job["id"])
    world.runner.process_next()
    assert world.runner.get(job["id"])["state"] == "done"


def test_a_playlist_that_cannot_be_read_fails_with_the_reason(world):
    world.sc.list_error = PlaylistError("yt-dlp could not read that playlist (private, deleted, or SoundCloud changed)")
    job = world.run()
    assert job["state"] == "failed" and "private" in job["error"]["message"] and job["error"]["phase"] == "listing"
    assert world.clock.slept == 0  # not worth retrying


def test_a_listing_timeout_is_retried_then_pauses(world):
    world.sc.list_error = PlaylistError("reading the playlist took too long", retryable=True)
    job = world.run()
    assert job["state"] == "paused" and world.sc.list_calls == len(jobs.BACKOFF_SECS) + 1
    assert world.clock.slept >= sum(jobs.BACKOFF_SECS)

    world.sc.list_error = None
    world.runner.retry(job["id"])
    world.runner.process_next()
    assert world.runner.get(job["id"])["state"] == "done"


def test_a_playlist_over_the_cap_fails_with_a_clear_message(world, monkeypatch):
    monkeypatch.setattr(jobs, "MAX_TRACKS", 3)
    job = world.run()
    assert job["state"] == "failed" and "more than 3 tracks" in job["error"]["message"]


def test_a_surprise_is_reported_without_details_and_logged(world, caplog):
    world.bp.search_hook = lambda n: 1 / 0
    job = world.run()
    assert job["state"] == "failed" and "ZeroDivision" not in job["error"]["message"]
    assert "crashed" in caplog.text


def test_a_track_beatport_will_not_add_goes_back_to_the_review(world):
    world.bp.unavailable = {1001}
    job = world.run()
    assert job["counts"]["added"] == 2 and job["needsReview"] == 5
    [row] = [t for t in world.runner.tracks(job["id"], "all")["tracks"] if t["index"] == 1]
    assert row["picked"] is None and "would not add" in row["error"]


def test_a_beatport_track_picked_twice_is_added_once(tmp_path):
    scenario = [("match", "Artist0 - Song0"), ("match", "Artist0 - Song0")]
    world = World(tmp_path, scenario)  # both titles search the same text, so both pick the same Beatport track
    job = world.run()
    assert job["counts"]["picked"] == 2 and job["counts"]["added"] == 2
    assert world.bp.added == [1001]  # sent once


# --- cancel and delete ---------------------------------------------------------------------------------------


def test_cancelling_a_running_job_stops_it_and_keeps_what_was_done(world):
    def stop(n):
        if n == 3:
            world.runner.cancel(job_id)

    world.bp.search_hook = stop
    job_id = world.runner.submit(PLAYLIST)[0]["id"]
    world.runner.process_next()
    job = world.runner.get(job_id)
    assert job["state"] == "cancelled" and job["error"] is None
    assert 0 < job["progress"]["done"] < job["progress"]["total"]

    world.bp.search_hook = None
    world.runner.retry(job_id)
    world.runner.process_next()
    job = world.runner.get(job_id)
    # the search in flight when the cancel came was finished and kept, so nothing is searched twice
    assert job["state"] == "done" and len(world.bp.queries) == len(set(world.bp.queries))


def test_a_queued_job_is_cancelled_at_once_and_a_finished_one_cannot_be(world):
    queued, _ = world.runner.submit(PLAYLIST)
    assert world.runner.cancel(queued["id"])["state"] == "cancelled"
    assert world.runner.process_next() is None
    done = world.run()
    with pytest.raises(JobError, match="cannot be cancelled"):
        world.runner.cancel(done["id"])


def test_a_running_job_cannot_be_deleted_but_others_can(world):
    outcome = {}

    def try_delete(n):
        if n == 1:
            try:
                world.runner.delete(job_id)
            except JobError as error:
                outcome["error"] = str(error)

    world.bp.search_hook = try_delete
    job_id = world.runner.submit(PLAYLIST)[0]["id"]
    world.runner.process_next()
    assert outcome["error"] == "cancel the job first"
    world.runner.delete(job_id)
    assert world.runner.list() == []
    assert not list((world.dir / "jobs").glob("*.json"))
    with pytest.raises(KeyError):
        world.runner.get(job_id)


def test_retry_refuses_what_is_running_or_has_nothing_to_retry(world):
    queued, _ = world.runner.submit(PLAYLIST)
    with pytest.raises(JobError, match="already running"):
        world.runner.retry(queued["id"])
    world.runner.process_next()
    with pytest.raises(JobError, match="nothing to retry"):
        world.runner.retry(queued["id"])


# --- the review ----------------------------------------------------------------------------------------------


def test_the_review_filters(world):
    job = world.run()
    rows = lambda which: [t["index"] for t in world.runner.tracks(job["id"], which)["tracks"]]  # noqa: E731
    assert rows("unmatched") == [2, 3, 6, 7]
    assert rows("maybe") == [2, 6] and rows("none") == [3, 7]
    assert rows("picked") == [0, 1, 5] and rows("unreadable") == [4] and rows("error") == []
    assert len(rows("all")) == 8
    with pytest.raises(JobError, match="unknown filter"):
        world.runner.tracks(job["id"], "bogus")


def test_the_review_pages(world):
    job = world.run()
    page = world.runner.tracks(job["id"], "all", offset=6, limit=5)
    assert page["total"] == 8 and [t["index"] for t in page["tracks"]] == [6, 7]


def test_a_track_row_shows_the_label_and_the_suggestions(world):
    job = world.run()
    [row] = world.runner.tracks(job["id"], "maybe", limit=1)["tracks"]
    assert row["label"] == "Artist2 - Song2" and row["verdict"] == "maybe" and row["picked"] is None
    assert row["candidates"][0]["id"] == 1002 and 0 < row["candidates"][0]["score"] < 1
    assert row["query"] == "Artist2 Song2"


def test_picking_a_suggestion_then_applying_adds_it_to_the_same_playlist(world):
    job = world.run()
    world.runner.pick(job["id"], 2, 1002)
    assert world.runner.get(job["id"])["pendingPicks"] == 1
    world.runner.apply(job["id"])
    world.runner.process_next()
    job = world.runner.get(job["id"])
    assert job["state"] == "done" and job["counts"]["added"] == 4 and job["pendingPicks"] == 0
    assert world.bp.created == ["My set"] and world.bp.added == [1000, 1001, 1005, 1002]


def test_the_counts_follow_the_picks(world):
    job = world.run()
    assert (job["counts"]["maybe"], job["counts"]["none"], job["needsReview"]) == (2, 2, 4)
    world.runner.pick(job["id"], 2, 1002)  # a "maybe" is picked
    counts = world.runner.get(job["id"])["counts"]
    assert (counts["maybe"], counts["match"], counts["picked"]) == (1, 3, 4)  # the pick moved one "maybe" out
    assert counts["maybe"] + counts["none"] + counts["error"] == world.runner.get(job["id"])["needsReview"]


def test_picking_can_be_undone_until_the_track_is_added(world):
    job = world.run()
    world.runner.pick(job["id"], 2, 1002)
    assert world.runner.pick(job["id"], 2, None)["picked"] is None
    with pytest.raises(JobError, match="not one of the suggestions"):
        world.runner.pick(job["id"], 2, 999)
    with pytest.raises(JobError, match="already in the Beatport playlist"):
        world.runner.pick(job["id"], 0, None)
    with pytest.raises(JobError, match="could not be read"):
        world.runner.pick(job["id"], 4, None)
    with pytest.raises(KeyError):
        world.runner.pick(job["id"], 99, None)


def test_apply_needs_a_finished_job_and_new_picks(world):
    queued, _ = world.runner.submit(PLAYLIST)
    with pytest.raises(JobError, match="finished"):
        world.runner.apply(queued["id"])
    world.runner.process_next()
    with pytest.raises(JobError, match="no new picks"):
        world.runner.apply(queued["id"])


def test_the_playlist_is_made_by_apply_when_nothing_was_confident(tmp_path):
    scenario = [("maybe", "Artist0 - Song0"), ("none", "Artist1 - Song1")]
    world = World(tmp_path, scenario)
    job = world.run()
    assert job["playlist"] is None and world.bp.created == [] and job["counts"]["picked"] == 0
    world.runner.pick(job["id"], 0, 1000)
    world.runner.apply(job["id"])
    world.runner.process_next()
    job = world.runner.get(job["id"])
    assert world.bp.created == ["My set"] and job["counts"]["added"] == 1


def test_searching_by_hand_offers_new_suggestions_and_clears_the_old_pick(world):
    job = world.run()
    world.bp.catalogue["better query"] = [
        {"id": 5000, "title": "Song3", "mix": "Original Mix", "artists": ["Artist3"], "durationSec": 300}
    ]
    row = world.runner.search_track(job["id"], 3, "  better query ")
    assert row["query"] == "better query" and [c["id"] for c in row["candidates"]] == [5000]
    assert row["verdict"] == "maybe" and row["picked"] is None  # a human picks, even a perfect hit
    world.runner.pick(job["id"], 3, 5000)
    world.runner.apply(job["id"])
    world.runner.process_next()
    assert 5000 in world.bp.added

    row = world.runner.search_track(job["id"], 6, "nothing like it")  # also fine for a track with no luck
    assert row["candidates"] == []
    with pytest.raises(JobError, match="type something"):
        world.runner.search_track(job["id"], 6, "   ")


def test_searching_by_hand_repairs_a_track_whose_search_had_failed(world):
    world.bp.search_hook = lambda n: (_ for _ in ()).throw(BeatportError("Beatport answered 400")) if n == 2 else None
    job = world.run()
    assert job["counts"]["error"] == 1
    world.bp.search_hook = None
    failed = world.runner.tracks(job["id"], "error")["tracks"][0]
    row = world.runner.search_track(job["id"], failed["index"], failed["query"])
    assert row["state"] == "matched" and row["error"] is None
    assert world.runner.get(job["id"])["counts"]["error"] == 0


def test_a_beatport_error_during_a_manual_search_reaches_the_caller(world):
    job = world.run()
    world.bp.search_hook = lambda n: (_ for _ in ()).throw(transient())
    with pytest.raises(BeatportError):
        world.runner.search_track(job["id"], 3, "x")


def test_a_save_survives_a_file_that_is_briefly_locked(world, monkeypatch):
    real, calls = jobs.os.replace, []

    def flaky(src, dst):
        calls.append(1)
        if len(calls) == 1:
            raise PermissionError("locked")
        return real(src, dst)

    monkeypatch.setattr(jobs.os, "replace", flaky)
    world.runner.submit(PLAYLIST)
    assert len(calls) == 2 and len(world.start().list()) == 1
