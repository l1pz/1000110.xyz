# Inbox Zero (`mail.1000110.xyz`)

Self-hosted [Inbox Zero](https://github.com/elie222/inbox-zero) (`v2.30.0`, AGPL-3.0) for personal Gmail via OpenRouter.

## Services and memory budget

| Service | Image | Network | `mem_limit` | Purpose |
| --- | --- | --- | --- | --- |
| `web` | `ghcr.io/elie222/inbox-zero:2.30.0` | `proxy`, `internal` | `1280m` | Next.js app + Prisma migrations on boot (`:3000`) |
| `db` | `postgres:16.16-alpine` | `internal` | `512m` | Users, rules, cached mail metadata, encrypted OAuth tokens (`./data/postgres`) |
| `redis` | `redis:7.4.12-alpine` | `internal` | `192m` | Ephemeral cache and rate-limit store (`tmpfs`, no persistence) |
| `serverless-redis-http` | `hiett/serverless-redis-http:0.0.10` | `internal` | `96m` | Upstash-compatible HTTP bridge to `redis` |
| `cron` | `alpine:3.24.4` | `internal` | `32m` | Recurring `curl` calls for scheduled actions, jobs, reminders, briefs, digests, watch renewal |

Total memory cap across the stack: **~2.1 GB** (VPS has 15 GiB RAM + 8 GiB swap).

## Security and deliberate omissions

- **No `tinyauth` middleware:** Google Pub/Sub pushes to `/api/google/webhook` and would be blocked by forward-auth. Login is gated by `AUTH_ALLOWED_EMAILS` and Google OAuth instead.
- **No `env_file:`:** `stack_deploy.py` runs `docker compose --project-directory /opt/stacks/inbox-zero -f <checkout>/compose.yaml --env-file <target>/.env config -q` before copying files, so compose reads `/opt/stacks/inbox-zero/.env` via `${VAR:?}` interpolation in `environment:`.
- **No BullMQ `worker` or QStash:** `QUEUE_BACKEND=internal` runs single-user jobs in-process, saving ~400 MB. Adding `worker` later requires a service running `/app/docker/scripts/start-worker.sh`, `REDIS_URL=redis://redis:6379`, `QUEUE_BACKEND=bullmq`, and persistent Redis storage.
- **Omitted SaaS integrations:** Resend (digests), Tinybird, PostHog, Sentry, Stripe, Loops, Microsoft, Slack, and Telegram are unset (`NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS=true`, `NEXT_PUBLIC_EMAIL_SEND_ENABLED=true`).

## Owner first-deploy steps

`.env` and the `/etc/stack-deploy/stacks` allowlist line must exist **before** the first CI dispatch, otherwise `docker compose config` fails on `${VAR:?}`.

1. **DNS:** Add `mail` A record pointing to the VPS IP (**DNS only**).
2. **Google Cloud OAuth + Pub/Sub:**
   - Enable the **Gmail API** (plus People/Calendar/Drive if used).
   - OAuth consent screen (**External** for personal Gmail): add your Gmail as a test user. Note: while in **Testing**, Google expires refresh tokens every **7 days**; switch to **In production** (unverified, 100-user cap, expected warning screen) unless Google requires verification for `gmail.modify`.
   - Web OAuth client authorized redirect URIs:
     - `https://mail.1000110.xyz/api/auth/callback/google`
     - `https://mail.1000110.xyz/api/google/linking/callback`
   - Scopes: `userinfo.profile`, `userinfo.email`, `gmail.modify`, `gmail.settings.basic`.
   - Pub/Sub: create topic `inbox-zero-emails`, grant `gmail-api-push@system.gserviceaccount.com` the **Pub/Sub Publisher** role, and create a **push** subscription to `https://mail.1000110.xyz/api/google/webhook?token=<TOKEN>`.
3. **Server `.env` and allowlist:**
   ```sh
   scp stacks/inbox-zero/.env.example mmate@1000110.xyz:/tmp/iz.env
   sudo mkdir -p /opt/stacks/inbox-zero
   sudo install -m 600 /tmp/iz.env /opt/stacks/inbox-zero/.env
   sudo nano /opt/stacks/inbox-zero/.env
   sudo bash /path/to/repo/deploy/install-stack-deploy.sh --allow inbox-zero=/opt/stacks/inbox-zero
   ```
4. **First deploy:** After the PR is merged to `main`, run **Actions → CI → Run workflow** (`branch: main`, `stack: inbox-zero`).
   - **First-boot timeout caveat:** Prisma migrations have a 320 s startup window while `stack_deploy.py` waits 180 s for `web` to become healthy. If the first dispatch reports a health wait timeout while migrations finish, run the workflow once more — subsequent boots are fast.
5. **Verify:**
   - `https://mail.1000110.xyz/api/health` returns `200 {"status":"ok"}`.
   - `docker compose ps` shows all five services `running` / `healthy`.
   - Sign in with Google at `https://mail.1000110.xyz`, confirm `/mail` loads, and send a test email to confirm Pub/Sub push arrives without a manual refresh.
6. **Enable auto-deploy:** Open a follow-up PR setting `"auto": true` in `stacks/manifest.json`.

## Upgrades and backups

- **Upgrading:** Bump the pinned `ghcr.io/elie222/inbox-zero:<version>` tag in `compose.yaml` via PR.
- **Backups:** `./data/postgres` is a live Postgres cluster; plain file copies can be inconsistent. Any `restic` backup must hook `pg_dump` / `pg_dumpall` and back up `/opt/stacks/inbox-zero/.env` (`EMAIL_ENCRYPT_SECRET` / `EMAIL_ENCRYPT_SALT` loss makes stored OAuth tokens undecryptable).
