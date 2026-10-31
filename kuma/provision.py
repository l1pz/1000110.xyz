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


def ensure_monitors(api: UptimeKumaApi, config: dict) -> dict:
    ids = {m["name"]: m["id"] for m in api.get_monitors()}
    for m in config["monitors"]:
        if m["name"] in ids:
            print(f"monitor {m['name']}: exists")
            continue
        res = api.add_monitor(
            type=MonitorType.HTTP,
            name=m["name"],
            url=m["url"],
            interval=config["interval"],
            retryInterval=config["interval"],
            maxretries=config["retries"],
        )
        ids[m["name"]] = res["monitorID"]
        print(f"monitor {m['name']}: created")
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


def main() -> int:
    env = dict(os.environ)
    config = json.loads((Path(__file__).parent / "monitors.json").read_text())
    api = UptimeKumaApi(env.get("KUMA_URL", "http://uptime-kuma:3001"))
    try:
        api.login(env["KUMA_USER"], env["KUMA_PASS"])
        ensure_notification(api, env)
        ids = ensure_monitors(api, config)
        ensure_status_page(api, config, ids)
    finally:
        api.disconnect()
    return 0


if __name__ == "__main__":
    sys.exit(main())
