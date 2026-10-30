"""Conversion jobs: list a SoundCloud playlist, read its tracks, match them on Beatport, create the playlist.

A job runs on the server with the page closed, one at a time, and is saved as a JSON file after every batch. Every
phase only does what is still undone, so a restart, a pause or a retry simply carries on. Failures are sorted:

- a private or deleted SoundCloud track is `unreadable` and never fails the job;
- a Beatport search that keeps failing marks that one track `error` and the job goes on (three in a row pause it);
- anything that needs the owner (login refused, playlist not found) stops the job with a plain message;
- rate limits, server errors and lost connections are retried with a growing wait, then pause the job.
"""

import json
import logging
import os
import re
import secrets
import threading
import time
from pathlib import Path

from beatport import BeatportError
from match import match_track
from parse import label, parse_track, search_query
from soundcloud import BadUrl, PlaylistError, check_url

log = logging.getLogger("sc2bp.jobs")

MAX_TRACKS = 1000
MAX_ACTIVE = 20  # queued, running or paused jobs
READ_BATCH = 10
SAVE_EVERY = 5  # a save after this many searches, or after SAVE_SECS, whichever comes first:
SAVE_SECS = 2  # a crash costs a couple of searches at most
ADD_BATCH = 50
BACKOFF_SECS = (5, 15, 45, 120, 300)
TRACK_FAILURES_BEFORE_PAUSE = 3
KEEP_CANDIDATES = 5
ID_PATTERN = re.compile(r"[0-9a-f]{8}")
ACTIVE = ("queued", "running", "paused")

FILTERS = ("unmatched", "maybe", "none", "error", "unreadable", "picked", "all")


class JobError(Exception):
    """A job or a request cannot go on. `retryable`: the job pauses (instead of failing) so a retry can work."""

    def __init__(self, message: str, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


class Cancelled(Exception):
    pass


def new_track(url: str) -> dict:
    return {
        "url": url,
        "state": "new",  # new -> read | blank -> read | unreadable; read -> matched | error
        "title": "",
        "uploader": "",
        "durationSec": None,
        "query": "",
        "verdict": None,  # match | maybe | none, once matched
        "candidates": [],
        "picked": None,  # the Beatport track id that will be (or was) added
        "added": False,
        "error": None,
    }


def chunks(items: list, size: int):
    for start in range(0, len(items), size):
        yield items[start : start + size]


class Runner:
    def __init__(self, data_dir: Path, soundcloud, beatport, sleep=time.sleep, clock=time.time):
        """`soundcloud` has `list_playlist(url)` and `read_tracks(urls)`; `beatport` is a function returning a client
        with `search`, `create_playlist` and `add_tracks` (it raises `BeatportError` when it cannot)."""
        self._dir = Path(data_dir) / "jobs"
        self._dir.mkdir(parents=True, exist_ok=True)
        self._sc = soundcloud
        self._beatport = beatport
        self._sleep = sleep
        self._clock = clock
        self._lock = threading.RLock()
        self._wake = threading.Condition(self._lock)
        self._jobs: dict[str, dict] = {}
        self._load()

    # --- storage ----------------------------------------------------------------------------------------------

    def _load(self) -> None:
        for path in sorted(self._dir.glob("*.json")):
            try:
                job = json.loads(path.read_text(encoding="utf-8"))
                if not ID_PATTERN.fullmatch(job["id"]) or not isinstance(job["tracks"], list):
                    raise ValueError("not a job")
            except (OSError, ValueError, KeyError, TypeError):
                log.warning("skipping unreadable job file %s", path.name)
                continue
            if job["state"] == "running":  # the server stopped mid-run: carry on from the saved progress
                job["state"] = "queued"
            job["waiting"] = None
            self._jobs[job["id"]] = job

    def _save(self, job: dict) -> None:
        """Caller holds the lock. Written to a temp file first, so a crash never leaves half a job."""
        job["updated"] = self._clock()
        path = self._dir / f"{job['id']}.json"
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(job, ensure_ascii=False), encoding="utf-8")
        for attempt in range(5):
            try:
                os.replace(tmp, path)
                return
            except PermissionError:  # Windows only: an antivirus or indexer briefly holds the file
                if attempt == 4:
                    raise
                time.sleep(0.05)

    def _get(self, job_id: str) -> dict:
        if not ID_PATTERN.fullmatch(job_id) or job_id not in self._jobs:
            raise KeyError(job_id)
        return self._jobs[job_id]

    # --- requests (called from the routes) --------------------------------------------------------------------

    def submit(self, url: str, name: str = "") -> tuple[dict, bool]:
        """A new job, or the job already working on that link. Returns `(summary, created)`."""
        url = check_url(url)
        with self._lock:
            for job in self._jobs.values():
                if job["url"] == url and job["state"] in ACTIVE:
                    return self.summary(job), False
            if sum(1 for j in self._jobs.values() if j["state"] in ACTIVE) >= MAX_ACTIVE:
                raise JobError(f"{MAX_ACTIVE} jobs are already waiting; let some finish first")
            job = {
                "id": secrets.token_hex(4),
                "url": url,
                "name": name.strip()[:100],
                "created": self._clock(),
                "updated": self._clock(),
                "state": "queued",
                "phase": "listing",
                "tracks": [],
                "playlist": None,
                "error": None,
                "waiting": None,
                "cancelRequested": False,
            }
            self._jobs[job["id"]] = job
            self._save(job)
            self._wake.notify_all()
            return self.summary(job), True

    def list_jobs(self) -> list[dict]:
        with self._lock:
            return [self.summary(j) for j in sorted(self._jobs.values(), key=lambda j: -j["created"])]

    def get(self, job_id: str) -> dict:
        with self._lock:
            return self.summary(self._get(job_id))

    def tracks(self, job_id: str, which: str = "unmatched", offset: int = 0, limit: int = 25) -> dict:
        if which not in FILTERS:
            raise JobError(f"unknown filter {which!r}")
        with self._lock:
            job = self._get(job_id)
            rows = [self._track_view(i, t) for i, t in enumerate(job["tracks"]) if self._wanted(t, which)]
            return {"total": len(rows), "tracks": rows[offset : offset + limit]}

    def cancel(self, job_id: str) -> dict:
        with self._lock:
            job = self._get(job_id)
            if job["state"] == "queued":
                job["state"] = "cancelled"
            elif job["state"] == "paused":
                job["state"] = "cancelled"
            elif job["state"] == "running":
                job["cancelRequested"] = True  # the worker notices between two steps
            else:
                raise JobError(f"a {job['state']} job cannot be cancelled")
            self._save(job)
            return self.summary(job)

    def retry(self, job_id: str) -> dict:
        """Carry on a failed, paused or cancelled job; on a finished one, try the tracks that hit an error again."""
        with self._lock:
            job = self._get(job_id)
            errored = [t for t in job["tracks"] if t["state"] == "error"]
            if job["state"] in ("queued", "running"):
                raise JobError("that job is already running")
            if job["state"] == "done" and not errored:
                raise JobError("nothing to retry")
            for track in errored:
                track["state"], track["error"] = "read", None
            self._requeue(job)
            return self.summary(job)

    def apply(self, job_id: str) -> dict:
        """Add the tracks picked since the playlist was made (or make it, if no track was confident enough)."""
        with self._lock:
            job = self._get(job_id)
            if job["state"] != "done":
                raise JobError("wait until the job has finished")
            if not any(t["picked"] is not None and not t["added"] for t in job["tracks"]):
                raise JobError("no new picks to add")
            self._requeue(job)
            return self.summary(job)

    def delete(self, job_id: str) -> None:
        with self._lock:
            job = self._get(job_id)
            if job["state"] == "running":
                raise JobError("cancel the job first")
            (self._dir / f"{job_id}.json").unlink(missing_ok=True)
            del self._jobs[job_id]

    def pick(self, job_id: str, index: int, candidate_id: int | None) -> dict:
        with self._lock:
            track = self._track(self._get(job_id), index)
            if track["added"]:
                raise JobError("that track is already in the Beatport playlist")
            if candidate_id is not None and candidate_id not in [c["id"] for c in track["candidates"]]:
                raise JobError("that is not one of the suggestions for this track")
            track["picked"] = candidate_id
            self._save(self._jobs[job_id])
            return self._track_view(index, track)

    def search_track(self, job_id: str, index: int, query: str) -> dict:
        """Search Beatport by hand for one track and offer the results (nothing is picked by this)."""
        query = query.strip()
        if not query:
            raise JobError("type something to search for")
        with self._lock:
            track = self._track(self._get(job_id), index)
            if track["added"]:
                raise JobError("that track is already in the Beatport playlist")
            parsed = parse_track(track["title"], track["uploader"], track["durationSec"])
        found = self._beatport().search(query)  # a BeatportError goes to the route
        result = match_track(parsed, found)
        with self._lock:
            track = self._track(self._get(job_id), index)
            track["query"] = query
            track["picked"] = None  # a new search replaces the old suggestions, so the old pick would dangle
            track["candidates"] = self._scored(result, KEEP_CANDIDATES)
            track["verdict"] = result.verdict if result.verdict != "match" else "maybe"  # a human picks these
            if track["state"] == "error":
                track["state"], track["error"] = "matched", None
            self._save(self._jobs[job_id])
            return self._track_view(index, track)

    # --- views ------------------------------------------------------------------------------------------------

    @staticmethod
    def _track(job: dict, index: int) -> dict:
        if not 0 <= index < len(job["tracks"]):
            raise KeyError(index)
        track = job["tracks"][index]
        if track["state"] in ("new", "blank", "unreadable"):
            raise JobError("that track could not be read, so there is nothing to match")
        return track

    @staticmethod
    def _wanted(track: dict, which: str) -> bool:
        picked = track["picked"] is not None
        return {
            "all": True,
            "picked": picked,
            "unmatched": track["state"] in ("matched", "error") and not picked,
            "maybe": track["verdict"] == "maybe" and not picked,
            "none": track["verdict"] == "none" and not picked,
            "error": track["state"] == "error",
            "unreadable": track["state"] == "unreadable",
        }[which]

    @staticmethod
    def _track_view(index: int, track: dict) -> dict:
        parsed = parse_track(track["title"], track["uploader"], track["durationSec"])
        return {
            "index": index,
            "url": track["url"],
            "label": label(parsed) if track["title"] else "(could not be read)",
            "title": track["title"],
            "uploader": track["uploader"],
            "durationSec": track["durationSec"],
            "state": track["state"],
            "verdict": track["verdict"],
            "picked": track["picked"],
            "added": track["added"],
            "error": track["error"],
            "query": track["query"] or search_query(parsed),
            "candidates": track["candidates"],
        }

    def summary(self, job: dict) -> dict:
        tracks = job["tracks"]
        count = lambda pred: sum(1 for t in tracks if pred(t))  # noqa: E731
        readable = count(lambda t: t["state"] in ("read", "matched", "error"))
        picked_ids = {t["picked"] for t in tracks if t["picked"] is not None}
        added_ids = {t["picked"] for t in tracks if t["picked"] is not None and t["added"]}
        phase = job["phase"]
        progress = {
            "listing": (0, 0),
            "reading": (count(lambda t: t["state"] not in ("new", "blank")), len(tracks)),
            "matching": (count(lambda t: t["state"] in ("matched", "error")), readable),
            "creating": (len(added_ids), len(picked_ids)),
            "finished": (1, 1),
        }[phase]
        counts = {
            # by where each track stands now: a pick moves a track out of "maybe" or "none"
            "match": count(lambda t: t["verdict"] == "match" and t["picked"] is not None),
            "maybe": count(lambda t: t["verdict"] in ("maybe", "match") and t["picked"] is None),
            "none": count(lambda t: t["verdict"] == "none" and t["picked"] is None),
            "error": count(lambda t: t["state"] == "error"),
            "unreadable": count(lambda t: t["state"] == "unreadable"),
            "picked": count(lambda t: t["picked"] is not None),
            "added": count(lambda t: t["added"]),
        }
        return {
            "id": job["id"],
            "name": job["name"],
            "url": job["url"],
            "state": job["state"],
            "phase": phase,
            "created": job["created"],
            "updated": job["updated"],
            "total": len(tracks),
            "progress": {"phase": phase, "done": progress[0], "total": progress[1]},
            "counts": counts,
            # tracks nothing was picked for: what a review would show
            "needsReview": count(lambda t: t["state"] in ("matched", "error") and t["picked"] is None),
            "pendingPicks": count(lambda t: t["picked"] is not None and not t["added"]),
            "waiting": job["waiting"],
            "error": job["error"],
            "playlist": job["playlist"],
        }

    # --- the worker -------------------------------------------------------------------------------------------

    def run_forever(self, stop: threading.Event) -> None:
        while not stop.is_set():
            job_id = self._claim(timeout=1.0)
            if job_id:
                self._process(job_id)

    def process_next(self) -> str | None:
        """Run the oldest queued job to its end (or pause); for tests and scripts."""
        job_id = self._claim(timeout=0)
        if job_id:
            self._process(job_id)
        return job_id

    def _claim(self, timeout: float) -> str | None:
        with self._wake:
            queued = lambda: sorted((j for j in self._jobs.values() if j["state"] == "queued"), key=lambda j: j["created"])  # noqa: E731
            if not queued() and timeout:
                self._wake.wait(timeout)
            jobs = queued()
            if not jobs:
                return None
            jobs[0]["state"] = "running"
            self._save(jobs[0])
            return jobs[0]["id"]

    def _requeue(self, job: dict) -> None:
        job.update(state="queued", error=None, waiting=None, cancelRequested=False)
        self._save(job)
        self._wake.notify_all()

    def _process(self, job_id: str) -> None:
        with self._lock:
            job = self._jobs[job_id]
        try:
            self._run(job)
        except Cancelled:
            self._end(job, "cancelled")
        except JobError as error:
            self._end(job, "paused" if error.retryable else "failed", str(error))
        except (BeatportError, PlaylistError) as error:
            self._end(job, "paused" if error.retryable else "failed", str(error))
        except Exception:
            log.exception("job %s crashed", job_id)
            self._end(job, "failed", "something unexpected went wrong (the server log has the details)")

    def _end(self, job: dict, state: str, message: str | None = None) -> None:
        with self._lock:
            job["state"] = state
            job["waiting"] = None
            job["cancelRequested"] = False
            job["error"] = {"message": message, "phase": job["phase"]} if message else None
            self._save(job)
        log.info("job %s is %s%s", job["id"], state, f": {message}" if message else "")

    def _phase(self, job: dict, phase: str) -> None:
        with self._lock:
            job["phase"] = phase
            self._save(job)

    def _check(self, job: dict) -> None:
        with self._lock:
            if job["cancelRequested"]:
                raise Cancelled

    def _wait(self, job: dict, seconds: float, reason: str) -> None:
        """Wait out a retry delay in short steps, so a cancel is noticed and the page can show the countdown."""
        with self._lock:
            job["waiting"] = {"until": self._clock() + seconds, "reason": reason}
            self._save(job)
        end = self._clock() + seconds
        while self._clock() < end:
            self._check(job)
            self._sleep(min(1.0, max(0.0, end - self._clock())))
        with self._lock:
            job["waiting"] = None
            self._save(job)

    def _retry(self, job: dict, call, what: str):
        """`call()`, tried again after a growing wait while the error says it is worth it."""
        for attempt in range(len(BACKOFF_SECS) + 1):
            try:
                return call()
            except (BeatportError, PlaylistError) as error:
                if not error.retryable or attempt == len(BACKOFF_SECS):
                    raise
                delay = max(BACKOFF_SECS[attempt], getattr(error, "retry_after", None) or 0)
                log.info("job %s: %s failed (%s), trying again in %ss", job["id"], what, error, delay)
                self._wait(job, delay, f"{what}: {error}")

    def _run(self, job: dict) -> None:
        self._list(job)
        self._read(job)
        self._match(job)
        self._create(job)
        with self._lock:
            job["phase"] = "finished"
        self._end(job, "done")

    def _list(self, job: dict) -> None:
        with self._lock:
            if job["tracks"]:
                return
        self._phase(job, "listing")
        self._check(job)
        listing = self._retry(job, lambda: self._sc.list_playlist(job["url"]), "reading the playlist")
        if len(listing["urls"]) > MAX_TRACKS:
            raise JobError(f"that playlist has more than {MAX_TRACKS} tracks")
        with self._lock:
            job["tracks"] = [new_track(u) for u in listing["urls"]]
            job["name"] = job["name"] or listing["name"][:100]
            self._save(job)

    def _read(self, job: dict) -> None:
        self._phase(job, "reading")
        # a track that comes back blank is read once more at the end: a hiccup is not a private track
        for state, final in (("new", "blank"), ("blank", "unreadable")):
            with self._lock:
                todo = [i for i, t in enumerate(job["tracks"]) if t["state"] == state]
            for batch in chunks(todo, READ_BATCH):
                self._check(job)
                urls = [job["tracks"][i]["url"] for i in batch]
                infos = self._retry(job, lambda: self._sc.read_tracks(urls), "reading tracks")
                with self._lock:
                    for i, info in zip(batch, infos, strict=True):
                        track = job["tracks"][i]
                        if info.get("title"):
                            track.update(
                                state="read",
                                title=info["title"],
                                uploader=info.get("uploader", ""),
                                durationSec=info.get("durationSec"),
                            )
                        else:
                            track["state"] = final
                    self._save(job)

    def _match(self, job: dict) -> None:
        self._phase(job, "matching")
        with self._lock:
            todo = [i for i, t in enumerate(job["tracks"]) if t["state"] == "read"]
        streak = 0
        last_save = self._clock()
        for n, i in enumerate(todo, 1):
            self._check(job)
            with self._lock:
                track = job["tracks"][i]
                parsed = parse_track(track["title"], track["uploader"], track["durationSec"])
            query = search_query(parsed)
            found: list[dict] = []
            if query:
                try:
                    found = self._retry(job, lambda: self._beatport().search(query), "searching Beatport")
                except BeatportError as error:
                    if error.fatal:
                        raise JobError(str(error)) from None
                    with self._lock:
                        track.update(state="error", error=str(error), query=query)
                    streak = streak + 1 if error.retryable else 0
                    if streak >= TRACK_FAILURES_BEFORE_PAUSE:
                        raise JobError(f"Beatport keeps failing ({error})", retryable=True) from None
                    continue
            streak = 0
            result = match_track(parsed, found)
            with self._lock:
                track.update(state="matched", error=None, query=query, verdict=result.verdict)
                track["candidates"] = self._scored(result, 1 if result.verdict == "match" else KEEP_CANDIDATES)
                if result.verdict == "match":
                    track["picked"] = result.ranked[0].candidate["id"]
                if n % SAVE_EVERY == 0 or self._clock() - last_save >= SAVE_SECS:
                    self._save(job)
                    last_save = self._clock()
        with self._lock:
            self._save(job)

    @staticmethod
    def _scored(result, keep: int) -> list[dict]:
        return [{**s.candidate, "score": round(s.score, 3)} for s in result.ranked[:keep]]

    def _create(self, job: dict) -> None:
        with self._lock:
            pending = [t for t in job["tracks"] if t["picked"] is not None and not t["added"]]
        if not pending:
            return
        self._phase(job, "creating")
        self._check(job)
        with self._lock:
            playlist = job["playlist"]
        if playlist is None:
            name = job["name"] or "SoundCloud playlist"
            made = self._retry(job, lambda: self._beatport().create_playlist(name), "creating the playlist")
            with self._lock:  # saved at once: a restart must never make a second playlist
                job["playlist"] = playlist = {"id": made["id"], "url": made["url"], "name": name}
                self._save(job)
        ids = list(dict.fromkeys(t["picked"] for t in pending))  # one Beatport track picked twice is added once
        for batch in chunks(ids, ADD_BATCH):
            self._check(job)
            took = set(self._retry(job, lambda: self._beatport().add_tracks(playlist["id"], batch), "adding tracks"))
            with self._lock:
                for track in job["tracks"]:
                    if track["picked"] in batch and not track["added"]:
                        if track["picked"] in took:
                            track["added"] = True
                        else:
                            track["picked"] = None
                            track["error"] = "Beatport would not add this track to the playlist"
                self._save(job)
