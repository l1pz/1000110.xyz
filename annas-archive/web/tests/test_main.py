import importlib
import io

import pytest
from fastapi.testclient import TestClient

from app.models import Result


@pytest.fixture
def main(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("AUTH_REQUIRED", "false")
    monkeypatch.setenv("SYNC_TOKEN", "titok")
    monkeypatch.setenv("WORKER_ENABLED", "false")
    monkeypatch.setenv("PUBLIC_URL", "http://testserver")
    monkeypatch.delenv("OIDC_ISSUER", raising=False)
    import app.main as module

    importlib.reload(module)
    return module


@pytest.fixture
def client(main):
    with TestClient(main.app) as test_client:
        yield test_client


def test_health_reports_an_empty_queue(client):
    body = client.get("/health").json()

    assert body["ok"] is True
    assert body["queued"] == 0
    assert body["clearance"] == "no"


def test_home_renders_the_search_box(client):
    response = client.get("/")

    assert response.status_code == 200
    assert "keres" in response.text
    assert "/search" in response.text


def test_queue_page_is_empty_at_first(client):
    response = client.get("/queue")

    assert response.status_code == 200
    assert "Üres a sor" in response.text


def test_search_shows_results(client, main, monkeypatch):
    monkeypatch.setattr(
        main.annas,
        "search",
        lambda query: [
            Result(title="Egri csillagok", author="Gárdonyi Géza", format="PDF", year=2000, size=1000, md5="b" * 32),
            Result(title="Egri csillagok", author="Gárdonyi Géza", format="EPUB", year=1994, size=2000, md5="a" * 32),
        ],
    )

    response = client.get("/search", params={"q": "Egri csillagok"})

    assert response.status_code == 200
    assert "Egri csillagok" in response.text
    # EPUB is listed before PDF on purpose.
    assert response.text.index("EPUB") < response.text.index("PDF")


def test_search_falls_back_to_libgen(client, main, monkeypatch):
    from app.sources.annas import ChallengeRequired

    def explode(query):
        raise ChallengeRequired()

    monkeypatch.setattr(main.annas, "search", explode)
    monkeypatch.setattr(main, "_mint_clearance", lambda: False)
    monkeypatch.setattr(
        main.libgen,
        "search",
        lambda query: [Result(title="Sorstalanság", author="Kertész Imre", format="EPUB", md5="c" * 32, source="libgen")],
    )

    response = client.get("/search", params={"q": "Sorstalanság"})

    assert response.status_code == 200
    assert "Sorstalanság" in response.text
    assert "Libgen" in response.text


def test_add_puts_a_book_in_the_queue(client):
    response = client.post(
        "/add",
        data={"title": "Egri csillagok", "author": "Gárdonyi Géza", "format": "EPUB", "md5": "a" * 32},
        follow_redirects=True,
    )

    assert response.status_code == 200
    assert "Egri csillagok" in response.text
    assert "várakozik" in response.text


def test_add_is_idempotent_for_the_same_md5(client, main):
    data = {"title": "Egri csillagok", "format": "EPUB", "md5": "a" * 32}
    client.post("/add", data=data, follow_redirects=True)
    client.post("/add", data=data, follow_redirects=True)

    assert len(main.store.list_books()) == 1


def test_upload_makes_the_file_downloadable(client):
    response = client.post(
        "/upload",
        files={"file": ("Egri csillagok.epub", io.BytesIO(b"PK\x03\x04tartalom"), "application/epub+zip")},
        follow_redirects=True,
    )
    assert response.status_code == 200
    assert "Egri csillagok" in response.text

    from app import main as module

    queued = module.store.list_books()[0]
    assert queued.status == "ready"
    assert queued.filename == "Egri csillagok.epub"

    download = client.get(f"/files/{queued.id}")
    assert download.status_code == 200
    assert download.content == b"PK\x03\x04tartalom"


def test_upload_refuses_an_unknown_extension(client):
    response = client.post(
        "/upload",
        files={"file": ("kép.png", io.BytesIO(b"x"), "image/png")},
    )

    assert response.status_code == 400


def test_sync_needs_the_token(client):
    assert client.get("/sync").status_code == 401
    assert client.get("/sync", params={"token": "rossz"}).status_code == 401


def test_sync_lists_ready_books(client, main):
    book = main.store.add_book(title="Kész könyv", author="Szerző", format="EPUB", md5="d" * 32)
    main.store.update_book(book.id, status="ready", filename="Kész könyv.epub", file_path="")

    body = client.get("/sync", headers={"Authorization": "Bearer titok"}).json()

    assert [item["title"] for item in body["books"]] == ["Kész könyv"]
    assert body["books"][0]["url"] == f"/sync/files/{book.id}"


def test_sync_ack_marks_the_book_sent(client, main):
    book = main.store.add_book(title="Átveendő", format="EPUB")

    assert client.post(f"/sync/ack/{book.id}", params={"token": "titok"}).status_code == 200
    assert main.store.get_book(book.id).status == "sent"


def test_opds_feed_lists_the_books(client, main):
    book = main.store.add_book(title="OPDS könyv", author="Szerző", format="EPUB")
    main.store.update_book(book.id, status="ready", filename="opds.epub")

    response = client.get("/opds", params={"token": "titok"})

    assert response.status_code == 200
    assert "application/atom+xml" in response.headers["content-type"]
    assert "OPDS könyv" in response.text
    assert f"/opds/files/{book.id}" in response.text


def test_login_page_when_auth_is_required(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("AUTH_REQUIRED", "true")
    monkeypatch.setenv("WORKER_ENABLED", "false")
    import app.main as module

    importlib.reload(module)
    with TestClient(module.app) as test_client:
        response = test_client.get("/")

    assert response.status_code == 401
    assert "Be kell lépni" in response.text