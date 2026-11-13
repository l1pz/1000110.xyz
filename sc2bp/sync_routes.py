"""HTTP shape of the liked-music sync (`syncer.py`). Behind the same Traefik rule and `tinyauth` as the rest of
`/api/sc2bp`, so there is no user check here."""

from typing import Annotated

from beatport import BeatportError
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, StringConstraints
from syncer import SyncError, Syncer

router = APIRouter(prefix="/api/sc2bp/sync")


class NightlyIn(BaseModel):
    enabled: bool | None = None
    hour: int | None = None
    minute: int | None = None
    tz: str | None = Field(None, max_length=60)


class GroupIn(BaseModel):
    id: str = Field(max_length=30)
    name: str = Field(max_length=40)
    genres: list[Annotated[str, StringConstraints(max_length=80)]] = Field(max_length=80)


class ConfigIn(BaseModel):
    source: str | None = Field(None, max_length=300)
    prefix: str | None = Field(None, max_length=40)
    cap: int | None = None
    nightly: NightlyIn | None = None
    groups: list[GroupIn] | None = Field(None, max_length=30)
    otherName: str | None = Field(None, max_length=40)


class PickIn(BaseModel):
    id: int | None


class SearchIn(BaseModel):
    query: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class GroupChoiceIn(BaseModel):
    group: str | None = Field(None, max_length=30)


class ImportIn(BaseModel):
    jobId: str = Field(max_length=8)


class GoneIn(BaseModel):
    playlistId: int
    action: str = Field(max_length=10)


def get_syncer(request: Request) -> Syncer:
    return request.app.state.syncer


def guarded(call, *args, status: int = 409):
    """Runs a syncer call and turns its errors into the right HTTP answer."""
    try:
        return call(*args)
    except KeyError:
        raise HTTPException(404, "no such run, track or playlist") from None
    except SyncError as error:
        raise HTTPException(status, str(error)) from None
    except BeatportError as error:
        raise HTTPException(503 if error.fatal else 502, str(error)) from None


@router.get("/health")
def health(syncer: Syncer = Depends(get_syncer)):
    """200 while all is well (or nothing has been set up yet), 503 when the owner has to act. For the Kuma monitor."""
    result = syncer.health()
    if not result["ok"]:
        raise HTTPException(503, result["message"] or result["status"])
    return result


@router.get("")
def status(syncer: Syncer = Depends(get_syncer)) -> dict:
    return syncer.status()


@router.post("/run")
def start(syncer: Syncer = Depends(get_syncer)) -> dict:
    run, created = guarded(syncer.start_run, "manual")
    return {"run": run, "created": created}


@router.post("/run/{run_id}/confirm")
def confirm(run_id: str, syncer: Syncer = Depends(get_syncer)) -> dict:
    return {"run": guarded(syncer.confirm_run, run_id)}


@router.post("/run/{run_id}/cancel")
def cancel(run_id: str, syncer: Syncer = Depends(get_syncer)) -> dict:
    return {"run": guarded(syncer.cancel_run, run_id)}


@router.get("/runs")
def runs(syncer: Syncer = Depends(get_syncer)) -> dict:
    return {"runs": syncer.runs()}


@router.get("/runs/{run_id}")
def run(run_id: str, syncer: Syncer = Depends(get_syncer)) -> dict:
    return {"run": guarded(syncer.get_run, run_id)}


@router.get("/inbox")
def inbox(
    which: str = Query("review", alias="filter"),
    offset: int = Query(0, ge=0),
    limit: int = Query(25, ge=1, le=100),
    syncer: Syncer = Depends(get_syncer),
) -> dict:
    return guarded(syncer.inbox, which, offset, limit, status=400)


@router.post("/videos/{vid}/pick")
def pick(vid: str, body: PickIn, syncer: Syncer = Depends(get_syncer)) -> dict:
    return {"track": guarded(syncer.pick, vid, body.id)}


@router.post("/videos/{vid}/search")
def search(vid: str, body: SearchIn, syncer: Syncer = Depends(get_syncer)) -> dict:
    return {"track": guarded(syncer.search_video, vid, body.query)}


@router.post("/videos/{vid}/skip")
def skip(vid: str, syncer: Syncer = Depends(get_syncer)) -> dict:
    return {"track": guarded(syncer.skip, vid)}


@router.post("/videos/{vid}/restore")
def restore(vid: str, syncer: Syncer = Depends(get_syncer)) -> dict:
    return {"track": guarded(syncer.restore, vid)}


@router.post("/videos/{vid}/group")
def group(vid: str, body: GroupChoiceIn, syncer: Syncer = Depends(get_syncer)) -> dict:
    return {"track": guarded(syncer.set_group, vid, body.group)}


@router.put("/config")
def config(body: ConfigIn, syncer: Syncer = Depends(get_syncer)) -> dict:
    patch = body.model_dump(exclude_none=True)
    if "nightly" in patch:
        patch["nightly"] = {k: v for k, v in patch["nightly"].items() if v is not None}
    return {"config": guarded(syncer.update_config, patch, status=400)}


@router.post("/import-job")
def import_job(body: ImportIn, syncer: Syncer = Depends(get_syncer)) -> dict:
    return guarded(syncer.import_job, body.jobId)


@router.post("/gone")
def gone(body: GoneIn, syncer: Syncer = Depends(get_syncer)) -> dict:
    return guarded(syncer.resolve_gone, body.playlistId, body.action)
