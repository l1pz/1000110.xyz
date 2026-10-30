"""sc2bp service: SoundCloud playlist to Beatport playlist, as background jobs that go on with the page closed.

Traefik puts the tinyauth forward auth in front of every route, and tinyauth is owner-only, so there is no user check
here. The work is in `jobs.py`; this file is the HTTP shape of it."""

import logging
import os
import threading
from contextlib import asynccontextmanager
from functools import lru_cache
from pathlib import Path
from typing import Annotated

import soundcloud
from beatport import Beatport, BeatportError
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request
from jobs import JobError, Runner
from pydantic import BaseModel, Field, StringConstraints
from soundcloud import BadUrl

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")

DATA_DIR = Path(os.environ.get("SC2BP_DATA", "/data"))


class JobIn(BaseModel):
    url: str = Field(max_length=300)
    name: Annotated[str, StringConstraints(strip_whitespace=True, max_length=100)] = ""


class PickIn(BaseModel):
    id: int | None


class SearchIn(BaseModel):
    query: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


@lru_cache
def beatport_client() -> Beatport:
    username = os.environ.get("BEATPORT_USERNAME", "")
    password = os.environ.get("BEATPORT_PASSWORD", "")
    if not username or not password:
        raise BeatportError("the Beatport login is not configured on the server", fatal=True)
    return Beatport(username, password, DATA_DIR / "token.json")


def get_runner(request: Request) -> Runner:
    return request.app.state.runner


@asynccontextmanager
async def lifespan(app: FastAPI):
    stop = threading.Event()
    app.state.runner = Runner(DATA_DIR, soundcloud, beatport_client)
    worker = threading.Thread(target=app.state.runner.run_forever, args=(stop,), name="sc2bp-worker", daemon=True)
    worker.start()
    yield
    stop.set()


router = APIRouter(prefix="/api/sc2bp")


def gone(error: KeyError) -> HTTPException:
    return HTTPException(404, "no such job or track")


@router.get("/health")
def health() -> dict:
    return {"ok": True}


@router.get("/me")
def me() -> dict:
    """Only reachable through tinyauth, so a 200 here means the visitor is logged in."""
    return {"ok": True}


@router.post("/jobs")
def start(body: JobIn, runner: Runner = Depends(get_runner)) -> dict:
    """Starts a conversion; a link that is already being converted gives that job back (`created: false`)."""
    try:
        job, created = runner.submit(body.url, body.name)
    except BadUrl as error:
        raise HTTPException(400, str(error)) from None
    except JobError as error:
        raise HTTPException(409, str(error)) from None
    return {"job": job, "created": created}


@router.get("/jobs")
def jobs(runner: Runner = Depends(get_runner)) -> dict:
    return {"jobs": runner.list_jobs()}


@router.get("/jobs/{job_id}")
def job(job_id: str, runner: Runner = Depends(get_runner)) -> dict:
    try:
        return {"job": runner.get(job_id)}
    except KeyError as error:
        raise gone(error) from None


@router.get("/jobs/{job_id}/tracks")
def tracks(
    job_id: str,
    which: str = Query("unmatched", alias="filter"),
    offset: int = Query(0, ge=0),
    limit: int = Query(25, ge=1, le=100),
    runner: Runner = Depends(get_runner),
) -> dict:
    try:
        return runner.tracks(job_id, which, offset, limit)
    except KeyError as error:
        raise gone(error) from None
    except JobError as error:
        raise HTTPException(400, str(error)) from None


def action(call, job_id: str, *args) -> dict:
    try:
        return {"job": call(job_id, *args)}
    except KeyError as error:
        raise gone(error) from None
    except JobError as error:
        raise HTTPException(409, str(error)) from None


@router.post("/jobs/{job_id}/cancel")
def cancel(job_id: str, runner: Runner = Depends(get_runner)) -> dict:
    return action(runner.cancel, job_id)


@router.post("/jobs/{job_id}/retry")
def retry(job_id: str, runner: Runner = Depends(get_runner)) -> dict:
    return action(runner.retry, job_id)


@router.post("/jobs/{job_id}/apply")
def apply(job_id: str, runner: Runner = Depends(get_runner)) -> dict:
    return action(runner.apply, job_id)


@router.delete("/jobs/{job_id}")
def delete(job_id: str, runner: Runner = Depends(get_runner)) -> dict:
    try:
        runner.delete(job_id)
    except KeyError as error:
        raise gone(error) from None
    except JobError as error:
        raise HTTPException(409, str(error)) from None
    return {"ok": True}


@router.post("/jobs/{job_id}/tracks/{index}/pick")
def pick(job_id: str, index: int, body: PickIn, runner: Runner = Depends(get_runner)) -> dict:
    try:
        return {"track": runner.pick(job_id, index, body.id)}
    except KeyError as error:
        raise gone(error) from None
    except JobError as error:
        raise HTTPException(409, str(error)) from None


@router.post("/jobs/{job_id}/tracks/{index}/search")
def search(job_id: str, index: int, body: SearchIn, runner: Runner = Depends(get_runner)) -> dict:
    try:
        return {"track": runner.search_track(job_id, index, body.query)}
    except KeyError as error:
        raise gone(error) from None
    except JobError as error:
        raise HTTPException(409, str(error)) from None
    except BeatportError as error:
        raise HTTPException(503 if error.fatal else 502, str(error)) from None


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
app.include_router(router)
