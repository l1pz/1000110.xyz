"""sc2bp service: lists a SoundCloud playlist, searches Beatport, creates the playlist. It makes no judgement about
matches (the browser scores them, see src/features/tools/tools/sc2bp/). Traefik puts the tinyauth forward auth in front
of every route, and tinyauth is owner-only, so there is no user check here."""

import logging
import os
from functools import lru_cache
from pathlib import Path
from typing import Annotated

from beatport import Beatport, BeatportError
from fastapi import APIRouter, Depends, FastAPI, HTTPException
from pydantic import BaseModel, Field, StringConstraints
from soundcloud import BadUrl, PlaylistError, list_playlist, read_tracks

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")

DATA_DIR = Path(os.environ.get("SC2BP_DATA", "/data"))
MAX_QUERIES = 10


class PlaylistIn(BaseModel):
    url: str = Field(max_length=300)


class TracksIn(BaseModel):
    urls: list[Annotated[str, StringConstraints(max_length=300)]] = Field(min_length=1, max_length=MAX_QUERIES)


class SearchIn(BaseModel):
    queries: list[Annotated[str, StringConstraints(max_length=200)]] = Field(max_length=MAX_QUERIES)


class CreateIn(BaseModel):
    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]
    ids: list[int] = Field(min_length=1, max_length=500)


@lru_cache
def get_beatport() -> Beatport:
    username = os.environ.get("BEATPORT_USERNAME", "")
    password = os.environ.get("BEATPORT_PASSWORD", "")
    if not username or not password:
        raise HTTPException(503, "the Beatport login is not configured on the server")
    return Beatport(username, password, DATA_DIR / "token.json")


def get_lister():
    return list_playlist


def get_track_reader():
    return read_tracks


router = APIRouter(prefix="/api/sc2bp")


@router.get("/health")
def health() -> dict:
    return {"ok": True}


@router.get("/me")
def me() -> dict:
    """Only reachable through tinyauth, so a 200 here means the visitor is logged in."""
    return {"ok": True}


@router.post("/playlist")
def playlist(body: PlaylistIn, list_links=Depends(get_lister)) -> dict:
    """The playlist's name and track links (fast); `/tracks` then resolves them a few at a time."""
    try:
        return list_links(body.url)
    except BadUrl as error:
        raise HTTPException(400, str(error)) from None
    except PlaylistError as error:
        raise HTTPException(502, str(error)) from None


@router.post("/tracks")
def tracks(body: TracksIn, read=Depends(get_track_reader)) -> dict:
    """Title, uploader and length of up to 10 track links, in order; an unreadable track is blank."""
    try:
        return {"tracks": read(body.urls)}
    except BadUrl as error:
        raise HTTPException(400, str(error)) from None


@router.post("/search")
def search(body: SearchIn, beatport: Beatport = Depends(get_beatport)) -> dict:
    try:
        # a blank query (a track with no readable title) finds nothing and costs no call
        return {"results": [beatport.search(q) if q.strip() else [] for q in body.queries]}
    except BeatportError as error:
        raise HTTPException(502, str(error)) from None


@router.post("/create")
def create(body: CreateIn, beatport: Beatport = Depends(get_beatport)) -> dict:
    try:
        return beatport.create_playlist(body.name, list(dict.fromkeys(body.ids)))
    except BeatportError as error:
        raise HTTPException(502, str(error)) from None


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
app.include_router(router)
