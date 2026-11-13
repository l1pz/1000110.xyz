"""Trying a Beatport or YouTube call again after a growing wait, for as long as its error says that could help.

Shared by the conversion jobs (`jobs.py`) and the sync (`syncer.py`), so both treat a rate limit, a server error and a
lost connection the same way."""

import logging
from collections.abc import Callable

from beatport import BeatportError
from errors import PlaylistError

log = logging.getLogger("sc2bp.retry")

BACKOFF_SECS = (5, 15, 45, 120, 300)


def retrying(call: Callable, wait: Callable[[float, str], None], what: str, label: str = ""):
    """`call()`, tried again after each wait in `BACKOFF_SECS` while the error is `retryable`.

    `wait(seconds, reason)` waits out one delay (it may raise to stop everything, e.g. a cancel). Beatport's own
    `Retry-After` wins when it asks for longer. The last error is raised when the waits run out or the error is not
    worth retrying (it needs the owner)."""
    for attempt in range(len(BACKOFF_SECS) + 1):
        try:
            return call()
        except (BeatportError, PlaylistError) as error:
            if not error.retryable or attempt == len(BACKOFF_SECS):
                raise
            delay = max(BACKOFF_SECS[attempt], getattr(error, "retry_after", None) or 0)
            log.info("%s%s failed (%s), trying again in %ss", f"{label}: " if label else "", what, error, delay)
            wait(delay, f"{what}: {error}")
