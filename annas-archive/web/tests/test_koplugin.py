"""The KOReader plugin is shipped code too: pin what it talks to.

The Lua itself is checked with luac in CI (the books job installs lua5.1); these
tests keep the metadata, the HTTP contract and one real bug from coming back.
"""

import shutil
import subprocess
from pathlib import Path

import pytest

PLUGIN = Path(__file__).resolve().parents[2] / "koplugin" / "annas-sync.koplugin"
MAIN = PLUGIN / "main.lua"


@pytest.fixture(scope="module")
def source() -> str:
    return MAIN.read_text(encoding="utf-8")


@pytest.fixture
def main(tmp_path, monkeypatch):
    monkeypatch.setenv("DATA_DIR", str(tmp_path))
    monkeypatch.setenv("AUTH_REQUIRED", "false")
    monkeypatch.setenv("SYNC_TOKEN", "titok")
    monkeypatch.setenv("WORKER_ENABLED", "false")
    monkeypatch.setenv("PUBLIC_URL", "http://testserver")
    monkeypatch.delenv("OIDC_ISSUER", raising=False)
    import importlib

    import app.main as module

    importlib.reload(module)
    return module


def test_the_metadata_matches_the_folder():
    meta = (PLUGIN / "_meta.lua").read_text(encoding="utf-8")

    assert PLUGIN.is_dir()
    assert PLUGIN.name == "annas-sync.koplugin"
    assert 'name = "annassync"' in meta
    assert "fullname" in meta


def test_it_calls_routes_the_app_has(main, source):
    routes = {route.path for route in main.app.routes}

    assert "/sync" in routes
    assert "/sync/files/{book_id}" in routes
    assert "/sync/ack/{book_id}" in routes
    assert 'server .. "/sync"' in source
    assert '"/sync/files/"' in source
    assert '"/sync/ack/"' in source


def test_the_socket_throwaway_does_not_shadow_gettext(source):
    # `_` is gettext in this file. `local code, _, status = socket.skip(...)`
    # replaces it with the headers table, so the next `_("...")` blows up only
    # on the error path (found by running the plugin against the real app).
    assert "local code, _, status" not in source
    assert source.count("local code, _headers, status") == 3


def test_lua_parses():
    luac = shutil.which("luac5.1") or shutil.which("luac")
    if not luac:
        pytest.skip("luac is not installed")

    result = subprocess.run([luac, "-p", str(MAIN)], capture_output=True, text=True)

    assert result.returncode == 0, result.stderr