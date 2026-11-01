# Uptime Kuma

Monitoring and email alerts. The public `/status/` page of the site reads Kuma's status-page JSON (Phase 3c, task 3 in `TASKS.md`).

## Routes
- `https://kuma.1000110.xyz`: admin UI, behind `tinyauth`.
- `https://1000110.xyz/api/status-page/...`: public, GET only, no auth. Nothing else of Kuma is public.

## Deploy
Copy this folder by hand to `/opt/stacks/uptime-kuma/` on the server, then:

    cd /opt/stacks/uptime-kuma && docker compose up -d

Data lives in `./data` (SQLite). Back it up by copying that folder while the container is stopped.

## Provisioning (monitors, email, status page)
Done by script, not by clicking. Create the Kuma admin account once in the browser (kuma.1000110.xyz, after the DNS record), then run it on the server (CI copies `provision.py`, `provision.sh` and `monitors.json` there when they change on `main`; the deploy does not run it):

    ssh -t mmate@<server> /opt/stacks/uptime-kuma/provision.sh

It asks for the admin login and the SMTP details (never stored, never seen by the AI), then creates the `email` notification (default for every monitor), the monitors in `monitors.json` and the published status page `main`. Running it again changes nothing that exists; edit `monitors.json` and re-run to add monitors (types: plain HTTP, `game`, and `json-query` with `query` and `expected`, as the `deploys` monitor that watches the latest completed GitHub Actions run on `main`; JSON and names are only visible after the tinyauth login, since 2026-11-01). A changed `url` is updated; a changed `query` or `expected` on an existing monitor is not, so edit that one in the Kuma UI too. It uses `uptime-kuma-api-v2==1.0.3`, which lists only Kuma 2.0.0-beta.2 as supported but worked against 2.5.9 (2026-10-31); recheck after a Kuma upgrade.

Check from outside: `curl -s https://1000110.xyz/api/status-page/main` answers 401 without the tinyauth login (a browser is redirected to it); a POST to the same path does not reach Kuma. Tests of the monitors.json mapping: `python -m pytest` in this folder (needs `requirements-dev.txt`). Real responses are saved in `tests/fixtures/kuma/`.

## Upgrading
Read the release notes, bump the tag in `compose.yaml`, `docker compose pull && docker compose up -d`, then check the monitors and `curl` the status-page JSON (its shape is not a stable API). If it breaks, put the old tag back (copy `./data` first: a major upgrade can migrate the database).
