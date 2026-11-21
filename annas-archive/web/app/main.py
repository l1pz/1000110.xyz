"""The books service: Hungarian UI, English routes.

Pages (browser, Pocket ID login): `/` search, `/queue`, `/upload`, `/files/{id}`.
Device endpoints (shared token, no login): `/sync`, `/sync/files/{id}`, `/sync/ack/{id}`, `/opds`.
The raw Anna's Archive API stays on this host as `/api`, served by the Node service in front of
Traefik, untouched by this app.
"""

from __future__ import annotations

import asyncio
import html
import logging
import secrets
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from . import worker
from .config import Config, load
from .models import Result, format_rank
from .sources.annas import AnnaSource, ChallengeRequired
from .sources.libgen import LibgenSource
from .store import Store

BASE_DIR = Path(__file__).parent
log = logging.getLogger("books")

config: Config = load()
config.ensure_dirs()
store = Store(config.db_path)
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))
templates.env.globals["auth_enabled"] = config.oidc_configured


def _mint_clearance() -> bool:
    from . import harvest

    return harvest.mint(config.annas_base, store.set_cookies)


_minting = threading.Event()


def _mint_in_background() -> None:
    """A challenge must not hold up a search: mint behind the scenes, answer from Libgen now."""
    if _minting.is_set():
        return

    def run() -> None:
        _minting.set()
        try:
            _mint_clearance()
        finally:
            _minting.clear()

    threading.Thread(target=run, name="clearance", daemon=True).start()


annas = AnnaSource(config.annas_base, cookies=store.cookies, refresh=_mint_clearance, save=store.set_cookies)
libgen = LibgenSource(config.libgen_base)

STATUS_TEXT = {
    "queued": "várakozik",
    "downloading": "letöltés…",
    "ready": "kész, várja a Kindle-t",
    "sent": "átkerült a Kindle-re",
    "failed": "nem sikerült",
}
FORMATS = {".epub", ".azw3", ".mobi", ".pdf", ".fb2", ".txt", ".doc", ".docx"}


# -- auth helpers --------------------------------------------------------


def _current_user(request: Request) -> dict | None:
    return request.session.get("user")


def _login_page(request: Request, status: int = 200) -> HTMLResponse:
    return templates.TemplateResponse(request, "login.html", {"user": None}, status_code=status)


def _device_token(request: Request) -> str:
    header = request.headers.get("authorization", "")
    token = header[7:].strip() if header.lower().startswith("bearer ") else ""
    return token or request.query_params.get("token", "")


def _device_ok(request: Request) -> bool:
    token = _device_token(request)
    if not token:
        return False
    if config.sync_token and secrets.compare_digest(token, config.sync_token):
        return True
    return store.touch_device(token)


# -- app -----------------------------------------------------------------


@asynccontextmanager
async def lifespan(_: FastAPI):
    task = asyncio.create_task(worker.run(config, store)) if config.worker_enabled else None
    log.info("books service up; auth %s, worker %s",
             "on" if config.oidc_configured else "off", "on" if task else "off")
    try:
        yield
    finally:
        if task:
            task.cancel()


app = FastAPI(title="Könyvek", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")


@app.middleware("http")
async def login_gate(request: Request, call_next):
    path = request.url.path
    public = path.startswith(("/auth/", "/sync", "/opds", "/health", "/static/"))
    if not public and config.auth_required and not _current_user(request):
        return _login_page(request, status=401)
    return await call_next(request)


# Registered after the gate on purpose: Starlette runs the last added middleware outermost, so the
# session exists by the time `login_gate` looks at it.
from starlette.middleware.sessions import SessionMiddleware  # noqa: E402

app.add_middleware(
    SessionMiddleware,
    secret_key=config.session_secret or secrets.token_hex(32),
    session_cookie="books_session",
    max_age=60 * 60 * 24 * 365,
    same_site="lax",
    https_only=config.public_url.startswith("https://"),
)


# -- oidc ----------------------------------------------------------------

if config.oidc_configured:
    from authlib.integrations.starlette_client import OAuth

    oauth = OAuth()
    oauth.register(
        name="pocket",
        server_metadata_url=f"{config.oidc_issuer.rstrip('/')}/.well-known/openid-configuration",
        client_id=config.oidc_client_id,
        client_secret=config.oidc_client_secret,
        client_kwargs={"scope": "openid profile email"},
    )

    @app.get("/auth/login")
    async def auth_login(request: Request):
        return await oauth.pocket.authorize_redirect(request, f"{config.public_url}/auth/callback")

    @app.get("/auth/callback", name="auth_callback")
    async def auth_callback(request: Request):
        token = await oauth.pocket.authorize_access_token(request)
        claims = token.get("userinfo") or {}
        groups = claims.get("groups") or token.get("groups") or []
        if config.allowed_group and groups and config.allowed_group not in groups:
            log.warning("login refused: %s is not in %s", claims.get("email"), config.allowed_group)
            return templates.TemplateResponse(
                request, "login.html", {"user": None, "error": "Ehhez a fiókhoz nincs jogosultság."},
                status_code=403,
            )
        request.session["user"] = {
            "sub": claims.get("sub", ""),
            "name": claims.get("name") or claims.get("preferred_username") or "Olvasó",
            "email": claims.get("email", ""),
        }
        return RedirectResponse("/", status_code=303)

    @app.post("/auth/logout")
    async def auth_logout(request: Request):
        request.session.clear()
        return RedirectResponse("/", status_code=303)
else:

    @app.get("/auth/login")
    async def auth_login_disabled():
        return RedirectResponse("/", status_code=303)

    @app.get("/auth/callback", name="auth_callback")
    async def auth_callback_disabled():
        return RedirectResponse("/", status_code=303)

    @app.post("/auth/logout")
    async def auth_logout_disabled(request: Request):
        request.session.clear()
        return RedirectResponse("/", status_code=303)


# -- pages ---------------------------------------------------------------


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    user = _current_user(request)
    recent = store.list_books(limit=6)
    return templates.TemplateResponse(
        request, "index.html", {"user": user, "recent": recent, "status_text": STATUS_TEXT}
    )


@app.get("/search", response_class=HTMLResponse)
async def search(request: Request, q: str = ""):
    user = _current_user(request)
    query = q.strip()
    results: list[Result] = []
    error = ""
    if query:
        results, error = await asyncio.to_thread(run_search, query)
        results.sort(key=lambda result: (format_rank(result.format), -(result.year or 0)))
    return templates.TemplateResponse(
        request,
        "search.html",
        {"user": user, "q": query, "results": results, "error": error},
    )


def run_search(query: str) -> tuple[list[Result], str]:
    try:
        return annas.search(query), ""
    except ChallengeRequired:
        log.warning("search hit the challenge; minting a clearance in the background")
        _mint_in_background()
    except Exception as error:  # noqa: BLE001
        log.warning("annas search failed: %s", error)

    try:
        return libgen.search(query), ""
    except Exception as error:  # noqa: BLE001
        log.warning("libgen search failed: %s", error)
        return [], "Most nem érhető el egyik könyvtár sem. Próbáld újra később."


@app.post("/add")
async def add(
    request: Request,
    title: str = Form(...),
    author: str = Form(""),
    year: str = Form(""),
    format: str = Form(""),
    size: str = Form("0"),
    md5: str = Form(""),
    source: str = Form("annas"),
):
    existing = store.find_book(md5) if md5 else None
    if existing and existing.status != "failed":
        return RedirectResponse("/queue", status_code=303)
    store.add_book(
        title=title.strip()[:300],
        author=author.strip()[:200],
        year=int(year) if year.strip().isdigit() else None,
        format=format.strip().upper()[:8],
        size=int(size) if size.strip().isdigit() else 0,
        md5=md5.strip(),
        source=source if source in {"annas", "libgen"} else "annas",
    )
    return RedirectResponse("/queue", status_code=303)


@app.get("/queue", response_class=HTMLResponse)
async def queue(request: Request):
    user = _current_user(request)
    books = store.list_books(limit=100)
    busy = any(book.status in {"queued", "downloading"} for book in books)
    return templates.TemplateResponse(
        request,
        "queue.html",
        {"user": user, "books": books, "status_text": STATUS_TEXT, "busy": busy},
    )


@app.post("/queue/{book_id}/delete")
async def queue_delete(book_id: str):
    store.delete_book(book_id)
    return RedirectResponse("/queue", status_code=303)


@app.get("/files/{book_id}")
async def file_download(book_id: str):
    book = store.get_book(book_id)
    if not book or book.status not in {"ready", "sent"} or not book.file_path:
        raise HTTPException(404)
    path = Path(book.file_path)
    if not path.is_file():
        raise HTTPException(404)
    return FileResponse(path, filename=book.filename or path.name)


@app.get("/upload", response_class=HTMLResponse)
async def upload_form(request: Request):
    return templates.TemplateResponse(request, "upload.html", {"user": _current_user(request)})


@app.post("/upload")
async def upload(request: Request, file: UploadFile = File(...)):
    name = Path(file.filename or "").name
    suffix = Path(name).suffix.lower()
    if suffix not in FORMATS:
        return templates.TemplateResponse(
            request, "upload.html", {"user": _current_user(request), "error": "Ezt a formátumot nem ismerem."},
            status_code=400,
        )
    book = store.add_book(title=Path(name).stem, format=suffix.lstrip(".").upper(), source="upload")
    dest = config.files_dir / f"{book.id}{suffix}"
    size = 0
    try:
        with dest.open("wb") as handle:
            while chunk := await file.read(1024 * 256):
                size += len(chunk)
                if size > config.max_upload_mb * 1024 * 1024:
                    handle.close()
                    dest.unlink(missing_ok=True)
                    store.update_book(book.id, status="failed", error="Túl nagy fájl.")
                    return templates.TemplateResponse(
                        request, "upload.html", {"user": _current_user(request), "error": "Túl nagy fájl."},
                        status_code=413,
                    )
                handle.write(chunk)
    finally:
        await file.close()
    store.update_book(book.id, status="ready", filename=name, file_path=str(dest), size=size)
    return RedirectResponse("/queue", status_code=303)


# -- device endpoints ----------------------------------------------------


@app.get("/sync")
async def sync(request: Request):
    if not _device_ok(request):
        raise HTTPException(401)
    books = store.ready_books(limit=20)
    return JSONResponse(
        {
            "books": [
                {
                    "id": book.id,
                    "title": book.title,
                    "author": book.author,
                    "filename": book.filename,
                    "format": book.format,
                    "size": book.size,
                    "url": f"/sync/files/{book.id}",
                }
                for book in books
            ]
        }
    )


@app.get("/sync/files/{book_id}")
async def sync_file(request: Request, book_id: str):
    if not _device_ok(request):
        raise HTTPException(401)
    return await file_download(book_id)


@app.post("/sync/ack/{book_id}")
async def sync_ack(request: Request, book_id: str):
    if not _device_ok(request):
        raise HTTPException(401)
    if not store.get_book(book_id):
        raise HTTPException(404)
    store.update_book(book_id, status="sent")
    return {"ok": True}


@app.get("/opds")
async def opds(request: Request):
    if not _device_ok(request):
        raise HTTPException(401)
    books = store.ready_books(limit=50)
    updated = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    entries = "".join(
        f"""  <entry>
    <title>{html.escape(book.title)}</title>
    <id>urn:books:{book.id}</id>
    <updated>{updated}</updated>
    <author><name>{html.escape(book.author)}</name></author>
    <dc:language>hu</dc:language>
    <dc:format>{html.escape(book.format.lower() or 'epub')}</dc:format>
    <link rel="http://opds-spec.org/acquisition" type="application/{'epub+zip' if book.format.upper() == 'EPUB' else 'octet-stream'}"
          href="/opds/files/{book.id}?token={_device_token(request)}"/>
  </entry>
"""
        for book in books
    )
    body = f"""<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/terms/" xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>urn:books:catalog</id>
  <title>Könyvek</title>
  <updated>{updated}</updated>
  <link rel="self" href="/opds"/>
{entries}</feed>
"""
    return Response(body, media_type="application/atom+xml;profile=opds-catalog")


@app.get("/opds/files/{book_id}")
async def opds_file(request: Request, book_id: str):
    if not _device_ok(request):
        raise HTTPException(401)
    return await file_download(book_id)


@app.get("/health")
async def health():
    books = store.list_books(limit=200)
    return {
        "ok": True,
        "queued": sum(1 for book in books if book.status == "queued"),
        "downloading": sum(1 for book in books if book.status == "downloading"),
        "ready": sum(1 for book in books if book.status == "ready"),
        "failed": sum(1 for book in books if book.status == "failed"),
        "clearance": "yes" if store.cookies().get("aa_ddg_check") else "no",
        "time": int(time.time()),
    }