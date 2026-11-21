"""Mint the DDoS-Guard clearance cookie with a real (headless) browser.

This runs rarely: the token lives 90 days and is bound to the server's IP, so it is only called when
a request comes back as a challenge. Chromium is a dependency of the image but never part of the
request path.

The one thing that matters is the User-Agent: `HeadlessChrome` in the string makes the challenge
loop forever (measured, 2026-11-21). Everything else the page probes (plugins, WebGL, cores) made no
difference, so we do not fake it - a browser that is not lying is harder to catch.

A failed attempt is not retried for `COOLDOWN` seconds: hammering the edge turns a challenge into a
502 for a while (seen on 2026-11-21), and the caller falls back to Libgen meanwhile.
"""

from __future__ import annotations

import os
import threading
import time
from collections.abc import Callable

from .config import BROWSER_UA

COOLDOWN = 600.0
_lock = threading.Lock()
_last_failure = 0.0


def mint(base_url: str, save: Callable[[dict[str, str]], None], timeout_s: int = 90) -> bool:
    """Open the search page, let the challenge solve itself, store the cookies. True on success."""
    global _last_failure
    if os.environ.get("HARVEST_DISABLED", "").lower() in {"1", "true", "yes"}:
        return False
    with _lock:
        if time.time() - _last_failure < COOLDOWN:
            return False
        ok = _mint(base_url, save, timeout_s)
        if not ok:
            _last_failure = time.time()
        return ok


def _mint(base_url: str, save: Callable[[dict[str, str]], None], timeout_s: int) -> bool:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:  # a slim dev install without the browser
        return False

    host = base_url.split("://", 1)[-1].split("/", 1)[0]
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                headless=True,
                args=["--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage", "--no-first-run"],
            )
            try:
                context = browser.new_context(
                    user_agent=BROWSER_UA,
                    locale="hu-HU",
                    timezone_id="Europe/Budapest",
                    viewport={"width": 1280, "height": 800},
                    extra_http_headers={"Accept-Language": "hu-HU,hu;q=0.9,en;q=0.8"},
                )
                page = context.new_page()
                try:
                    page.goto(
                        f"{base_url}/search?q=magyar&lang=hu",
                        wait_until="domcontentloaded",
                        timeout=timeout_s * 1000,
                    )
                except Exception:  # noqa: BLE001 - the challenge reloads the page under our feet
                    pass
                for _ in range(60):
                    try:
                        if page.query_selector('a[href^="/md5/"]'):
                            break
                    except Exception:  # noqa: BLE001 - the challenge reloads the page mid-query
                        pass
                    page.wait_for_timeout(1000)
                cookies = {
                    cookie["name"]: cookie["value"]
                    for cookie in context.cookies()
                    if host in (cookie.get("domain") or "").lstrip(".")
                }
            finally:
                browser.close()
    except Exception:  # noqa: BLE001 - a broken browser is just "no clearance"
        return False
    if not cookies.get("aa_ddg_check"):
        return False
    save(cookies)
    return True