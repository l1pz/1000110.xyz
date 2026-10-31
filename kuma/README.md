# Uptime Kuma

Monitoring and email alerts. The public `/status/` page of the site reads Kuma's status-page JSON (Phase 3c, task 3 in `TASKS.md`).

## Routes
- `https://kuma.1000110.xyz`: admin UI, behind `tinyauth`.
- `https://1000110.xyz/api/status-page/...`: public, GET only, no auth. Nothing else of Kuma is public.

## Deploy
Copy this folder by hand to `/opt/stacks/uptime-kuma/` on the server, then:

    cd /opt/stacks/uptime-kuma && docker compose up -d

Data lives in `./data` (SQLite). Back it up by copying that folder while the container is stopped.

## Owner steps (the AI never sees these)
1. DNS: an `A` record for `kuma.1000110.xyz` (same IP as the apex).
2. Open the admin UI and create the Kuma admin account (tinyauth is the outer gate, this is the inner one).
3. Settings > Notifications: add SMTP details and tick "Default enabled" so every monitor mails you.
4. Monitors (keep names neutral, they are public): website, tinyauth, sc2bp (`http://sc2bp:8000/api/sc2bp/health`, Docker network), ruminant (optional).
5. Status Pages > New: slug `main`, add the monitors in groups, publish.
6. Check from outside: `curl -s https://1000110.xyz/api/status-page/main` returns JSON; `curl -X POST` to the same path does not reach Kuma.

## Upgrading
Read the release notes, bump the tag in `compose.yaml`, `docker compose pull && docker compose up -d`, then check the monitors and `curl` the status-page JSON (its shape is not a stable API). If it breaks, put the old tag back (copy `./data` first: a major upgrade can migrate the database).
