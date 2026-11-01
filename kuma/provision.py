"""Create the Kuma notification, monitors and status page from monitors.json.

Safe to run again: anything that already exists (matched by name or slug) is left alone.
Reads KUMA_URL, KUMA_USER, KUMA_PASS, and optionally KUMA_SMTP_HOST, KUMA_SMTP_PORT,
KUMA_SMTP_USER, KUMA_SMTP_PASS, KUMA_SMTP_FROM, KUMA_SMTP_TO from the environment.
Needs `uptime-kuma-api-v2==1.0.3`. Run it through provision.sh (it asks for the secrets).
"""

import json
import os
import sys
from pathlib import Path

from uptime_kuma_api import MonitorType, NotificationType, UptimeKumaApi

NOTIFICATION_NAME = "email"


def ensure_notification(api: UptimeKumaApi, env: dict) -> None:
    if not env.get("KUMA_SMTP_HOST"):
        print("notification: no KUMA_SMTP_HOST, skipped")
        return
    if any(n["name"] == NOTIFICATION_NAME for n in api.get_notifications()):
        print("notification: exists")
        return
    api.add_notification(
        name=NOTIFICATION_NAME,
        type=NotificationType.SMTP,
        isDefault=True,
        applyExisting=True,
        smtpHost=env["KUMA_SMTP_HOST"],
        smtpPort=int(env.get("KUMA_SMTP_PORT", "587")),
        smtpSecure=env.get("KUMA_SMTP_PORT") == "465",
        smtpUsername=env.get("KUMA_SMTP_USER", ""),
        smtpPassword=env.get("KUMA_SMTP_PASS", ""),
        smtpFrom=env["KUMA_SMTP_FROM"],
        smtpTo=env["KUMA_SMTP_TO"],
    )
    print("notification: created")


def monitor_kwargs(m: dict, config: dict) -> dict:
    """The `add_monitor` arguments for one entry of monitors.json (pure, so it can be tested without a Kuma)."""
    common = dict(
        name=m["name"],
        interval=m.get("interval", config["interval"]),
        retryInterval=m.get("interval", config["interval"]),
        maxretries=m.get("retries", config["retries"]),
    )
    kind = m.get("type", "http")
    if kind == "game":
        # asks the game server itself; a TCP check would pass through Docker's port proxy even when the game is down
        return dict(type=MonitorType.GAMEDIG, game=m["game"], hostname=m["host"], port=m["port"], **common)
    if kind == "json-query":
        # a JSONata query on the answer, compared with `expected` (Kuma 2)
        return dict(
            type=MonitorType.JSON_QUERY, url=m["url"], jsonPath=m["query"], expectedValue=m["expected"], **common, **m.get("extra", {})
        )
    if kind != "http":
        raise ValueError(f"monitor {m['name']}: unknown type {kind!r}")
    # "extra" holds per-monitor overrides, e.g. accept a 302 instead of following it
    return dict(type=MonitorType.HTTP, url=m["url"], **common, **m.get("extra", {}))


def late_fields(m: dict) -> dict:
    """Fields the client library cannot set when adding a monitor; they are applied with `edit_monitor` (which passes
    any field through). Kuma 2 needs the comparison of a json-query monitor: without it every check fails with
    "Invalid condition null"."""
    if m.get("type") == "json-query":
        return {"jsonPathOperator": m.get("operator", "==")}
    return {}


def ensure_monitors(api: UptimeKumaApi, config: dict) -> dict:
    current = {m["name"]: m for m in api.get_monitors()}
    ids = {name: m["id"] for name, m in current.items()}
    for m in config["monitors"]:
        name = m["name"]
        if name not in ids and m.get("was") in ids:  # renamed in the config
            api.edit_monitor(ids[m["was"]], name=name)
            ids[name] = ids.pop(m["was"])
            print(f"monitor {m['was']}: renamed to {name}")
            continue
        if name in ids:
            changed = False
            if m.get("url") and current.get(name, {}).get("url") != m["url"]:
                # the URL changed in the config: update it, back to the defaults plus the overrides
                defaults = {"maxredirects": 10, "accepted_statuscodes": ["200-299"]}
                api.edit_monitor(ids[name], url=m["url"], **{**defaults, **m.get("extra", {})})
                changed = True
            late = {k: v for k, v in late_fields(m).items() if current.get(name, {}).get(k) != v}
            if late:
                api.edit_monitor(ids[name], **late)
                changed = True
            print(f"monitor {name}: {'updated' if changed else 'exists'}")
            continue
        res = api.add_monitor(**monitor_kwargs(m, config))
        ids[name] = res["monitorID"]
        if late_fields(m):
            api.edit_monitor(ids[name], **late_fields(m))
        print(f"monitor {name}: created")
    return ids


def ensure_status_page(api: UptimeKumaApi, config: dict, ids: dict) -> None:
    sp = config["status_page"]
    if not any(p["slug"] == sp["slug"] for p in api.get_status_pages()):
        api.add_status_page(sp["slug"], sp["title"])
        print(f"status page {sp['slug']}: created")
    groups: dict[str, list] = {}
    for m in config["monitors"]:
        groups.setdefault(m["group"], []).append({"id": ids[m["name"]]})
    api.save_status_page(
        sp["slug"],
        title=sp["title"],
        published=True,
        showPoweredBy=False,
        publicGroupList=[{"name": n, "monitorList": ml} for n, ml in groups.items()],
    )
    print(f"status page {sp['slug']}: saved")


def connect(make_api, url: str, user: str, password: str, attempts: int = 3):
    """Connects and logs in. A timeout is retried (a connection that never answers happened on 2026-11-01 while Kuma's own
    log was healthy); a wrong password or any other error is not."""
    for attempt in range(1, attempts + 1):
        api = make_api(url, timeout=60)
        try:
            api.login(user, password)
            return api
        except Exception as error:
            api.disconnect()
            if type(error).__name__ != "TimeoutError" or attempt == attempts:
                raise
            print(f"login timed out (attempt {attempt} of {attempts}), trying again")


def main() -> int:
    env = dict(os.environ)
    config = json.loads((Path(__file__).parent / "monitors.json").read_text())
    api = connect(UptimeKumaApi, env.get("KUMA_URL", "http://uptime-kuma:3001"), env["KUMA_USER"], env["KUMA_PASS"])
    try:
        ensure_notification(api, env)
        ids = ensure_monitors(api, config)
        ensure_status_page(api, config, ids)
    finally:
        api.disconnect()
    return 0


if __name__ == "__main__":
    sys.exit(main())
