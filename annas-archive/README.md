# Books: Anna's Archive for the family Kindle

Two things run in this stack, on one host, `books.1000110.xyz`:

1. **The books site** (`annas-web`): a small Hungarian web app on a phone. Search, one tap to add,
   and the book lands on the Kindle by itself. Login is Pocket ID (Face ID); the e-reader uses a
   device token instead, because KOReader cannot do OIDC.
2. **The raw API** (`annas-archive-api` + `annas-gate`): the owner's JSON API on `/api`, unchanged,
   still key-gated. It is the same container as before, only the host moved.

`annas.1000110.xyz` now redirects here (301), so old bookmarks and the e-reader's settings keep
working. The Kindle half lives in `koplugin/annas-sync.koplugin/` (see below).

```
Phone (Safari)                        Kindle + KOReader
  books.1000110.xyz                     /sync, /opds  (device token)
  Pocket ID login (Face ID)                   |
        |                                     v
        v                              annas-sync.koplugin
  annas-web  ------------------------------> /mnt/us/books
    |  SQLite queue + worker
    |  1. annas-archive.gd   (search, metadata, slow download)
    |  2. libgen.li          (fallback, needs no cookie)
    v
  /data/files/<id>.<ext>   (kept until the reader acks, max 7 days)
```

## Why two sources

Anna's Archive has the better index (50 results a page, clean title/author/year, original filename)
and its free "slow download" hands out a direct partner URL. But it sits behind DDoS-Guard: a
cookieless request gets a 403 challenge, and the clearance cookie (`aa_ddg_check`, valid 90 days)
can only be minted by running their JavaScript.

So the worker tries Anna's Archive first and Libgen second, where Libgen needs no cookie at all
(`index.php` -> `ads.php` -> `get.php`). If both fail the book shows "nem sikerült" with a Hungarian
reason instead of retrying forever.

The clearance is not a proxy: once minted, everything is plain HTTP. `app/harvest.py` launches the
bundled Chromium only when a request comes back as a challenge (roughly every 90 days, or when the
VPS IP changes). The one thing that matters is the User-Agent: `HeadlessChrome` in the string makes
the challenge loop forever; a normal Chrome UA passes in about 15 seconds. Faking plugins, WebGL or
CPU cores made no difference, so the harvester does not fake them.

A failed mint is not retried for ten minutes: hammering the edge turns a challenge into a 502 for a
while. Searches never wait for the browser; they answer from Libgen and mint in the background.

## Routes

Browser, behind Pocket ID (`/auth/login`, `/auth/callback`):

| Route | What it does |
| --- | --- |
| `GET /` | search box + the last few queue entries |
| `GET /search?q=` | Hungarian results, EPUB -> AZW3 -> MOBI -> PDF |
| `POST /add` | queue one result (idempotent per md5) |
| `GET /queue` | statuses; refreshes itself while work is in flight |
| `GET /files/{id}` | download the finished file to the phone |
| `GET /upload`, `POST /upload` | add a file already on the phone (iPhone: Fájlok) |

Device endpoints, `Authorization: Bearer <SYNC_TOKEN>` (or `?token=`):

| Route | What it does |
| --- | --- |
| `GET /sync` | JSON list of ready books |
| `GET /sync/files/{id}` | the file |
| `POST /sync/ack/{id}` | mark it delivered (the file is then deleted after a week) |
| `GET /opds` | OPDS 1.2 catalogue, the fallback with no plugin |

`GET /health` is public: queue counts and whether a clearance cookie exists.

## KOReader plugin

`koplugin/annas-sync.koplugin/` is the other half: KOReader asks `/sync` for finished books,
downloads each one into the Kindle's books folder, and acknowledges it. No cable, no OPDS.

Install (once, over USB):

1. Copy `annas-sync.koplugin` into `koreader/plugins/` on the Kindle, so that
   `koreader/plugins/annas-sync.koplugin/main.lua` exists.
2. Restart KOReader (or enable it in Tools -> Plugin management).
3. Tools -> More tools -> "Könyvek (Anna's Archive)", then set:
   - **Szerver**: `https://books.1000110.xyz`
   - **Eszköztoken**: the `SYNC_TOKEN` from the server's `.env`
   - **Mappa**: `/mnt/us/books` (the default)
4. "Szinkronizálás most" runs a sync by hand. With automatic sync on (the default) it also runs
   when Wi-Fi connects and a few seconds after a wake-up. A finished batch shows a notification;
   the files appear in the file browser (open the folder again if it is already on screen).

Behaviour worth knowing:

- Files are written as `<name>.part` and renamed only when complete, so an interrupted download
  never leaves half a book.
- A book is acknowledged only after the file is on disk. If the file is already there (a lost ack,
  a re-flash), the plugin just acknowledges again and does not download twice.
- Filenames are made FAT32-safe on the device (invalid characters become `_`, paths are stripped),
  because uploads keep the name the phone sent.
- A manual sync may turn Wi-Fi on; an automatic one never does, and does nothing while offline.
- The automatic attempt is throttled to once a minute: FileManager and ReaderUI each hold an
  instance and `NetworkConnected` can fire more than once.

OPDS is still the no-plugin fallback: add `https://books.1000110.xyz/opds?token=<SYNC_TOKEN>` as a
catalogue in KOReader.

The plugin is tested in two ways: `web/tests/test_koplugin.py` pins the metadata, the three routes
and `luac -p` syntax; the sync itself was run against the real app with KOReader stubbed (Lua 5.5
through Lupa), covering download, ack, idempotence and the 401 path.

## The owner's API

`/api` is still `annas-archive-api` behind `annas-gate`: a Traefik forwardAuth that compares the
SHA-256 of `Authorization: Bearer <key>` with `ANNAS_KEY_SHA256`. It never sees the plaintext key and
does not depend on the books app. The KOReader API host is now `books.1000110.xyz`.

## Server setup (owner, once)

1. DNS: `books` and `annas` A records -> the VPS IP, **DNS only** (grey cloud). Certificates come
   from the existing DNS-01 challenge.
2. `.env` in `/opt/stacks/annas-archive` (see `.env.example`):

   ```sh
   sudo tee /opt/stacks/annas-archive/.env >/dev/null <<'EOF'
   ANNAS_KEY=<your Anna's Archive key>
   ANNAS_KEY_SHA256=<64 hex characters: sha256 of the key>
   OIDC_ISSUER=https://id.1000110.xyz
   OIDC_CLIENT_ID=<Pocket ID client "Books">
   OIDC_CLIENT_SECRET=<the client's secret>
   SESSION_SECRET=<openssl rand -hex 32>
   SYNC_TOKEN=<openssl rand -hex 24>
   ALLOWED_GROUP=books
   EOF
   sudo chmod 600 /opt/stacks/annas-archive/.env
   ```

3. Pocket ID: the OIDC client **Books** needs the redirect URI
   `https://books.1000110.xyz/auth/callback` and the allowed group `books`. Her account goes in
   `books` only (never `admin`).
4. Allowlist the stack: `sudo bash deploy/install-stack-deploy.sh --allow annas-archive=/opt/stacks/annas-archive`
5. Deploy: Actions -> CI -> Run workflow, branch `main`, `stack` = `annas-archive`. The first build
   pulls Chromium into the web image (~1 GB), so it takes a few minutes.
6. Check: `curl -s https://books.1000110.xyz/health` (queue counts, `clearance`), then log in once on
   the phone. The first search mints the clearance if it is missing.

## Logs and data

- `docker logs annas-web` (worker + clearance), `docker logs annas-archive-api`, `docker logs annas-gate`.
- Queue and cookies: the `books-data` volume (`/data/books.db`), files in `/data/files`.
- The clearance can be re-minted by hand:
  `docker exec annas-web python -c "from app import harvest; from app.store import Store; from app.config import load; print(harvest.mint(load().annas_base, Store(load().db_path).set_cookies))"`

## Updating upstream

The API service builds `bitesized/annas-archive-api` from a pinned commit (`UPSTREAM_SHA` in
`compose.yaml`); bump it deliberately. The books app parses Anna's Archive and Libgen HTML directly;
if one of them changes, the tests in `web/tests/` say which parser broke. Refresh the fixtures with
real pages when that happens.

## Notes

- No Kuma monitor: the health endpoint is public, adding one is a one-line change if wanted.
- Anna's Archive is a shadow library. This is a personal setup for material you have the right to read.