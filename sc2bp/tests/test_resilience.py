import pytest
from beatport import BeatportError
from errors import PlaylistError
from resilience import BACKOFF_SECS, retrying


def flaky(failures, error):
    state = {"calls": 0}

    def call():
        state["calls"] += 1
        if state["calls"] <= failures:
            raise error
        return "ok"

    return call, state


def test_a_retryable_error_is_tried_again_after_each_wait_then_succeeds():
    waits = []
    call, state = flaky(2, BeatportError("503", retryable=True))
    assert retrying(call, lambda s, r: waits.append((s, r)), "searching") == "ok"
    assert state["calls"] == 3
    assert waits == [(BACKOFF_SECS[0], "searching: 503"), (BACKOFF_SECS[1], "searching: 503")]


def test_the_waits_run_out_and_the_last_error_is_raised():
    waits = []
    call, state = flaky(99, PlaylistError("timeout", retryable=True))
    with pytest.raises(PlaylistError, match="timeout"):
        retrying(call, lambda s, r: waits.append(s), "listing")
    assert state["calls"] == len(BACKOFF_SECS) + 1
    assert waits == list(BACKOFF_SECS)


def test_an_error_that_needs_the_owner_is_not_retried():
    call, state = flaky(99, BeatportError("login refused", fatal=True))
    with pytest.raises(BeatportError):
        retrying(call, lambda s, r: pytest.fail("must not wait"), "login")
    assert state["calls"] == 1


def test_beatports_retry_after_wins_when_it_is_longer():
    waits = []
    call, _ = flaky(1, BeatportError("slow down", retryable=True, retry_after=90))
    retrying(call, lambda s, r: waits.append(s), "adding")
    assert waits == [90]


def test_the_waiter_can_stop_everything_by_raising():
    class Stop(Exception):
        pass

    def wait(seconds, reason):
        raise Stop

    call, state = flaky(99, BeatportError("503", retryable=True))
    with pytest.raises(Stop):
        retrying(call, wait, "x")
    assert state["calls"] == 1
