# BookOrbit (evaluated 2026-11-21, **on hold**)

A plan for replacing the Hungarian books site with [BookOrbit](https://bookorbit.app), keeping our
Anna's Archive downloader as its source. Nothing here is built. The owner is asking whether the
family actually needs it; the current site + `annas-sync.koplugin` is good enough. **Do not start
step 1 until the owner says yes.**

## Why it came up

BookOrbit is a self-hosted library (AGPL-3.0, Docker + PostgreSQL with `vector`) that already does
most of what the books stack was growing into:

- libraries for ebooks, PDFs, comics and audiobooks; built-in web, iOS and Apple Watch readers
- Kobo + KOReader **progress and annotation sync**, plus its own **KOReader plugin** with a catalog
  browser, search, download, status and rating
- OPDS, metadata providers, collections, statistics
- multi-user with **OIDC/SSO** (Pocket ID is explicitly supported, with group -> permission mapping)
- **book requests**: sources -> download client -> Library Dock -> import check -> filed ->
  notification, with automation and release profiles

It also solves things the current site cannot: progress sync between the phone, the Paperwhite and
the web reader, covers and metadata, and a library her account can browse.

## What it costs

- A second stack: app (~1 GB image, 512 MB+ RAM) and a PostgreSQL database to back up. The
  zero-bloat rule is for our own site, not for a third-party service, but the owner must agree.
- Book requests are labelled **Beta** upstream, and the plugin contract is versioned
  (`PLUGIN_API_VERSION = 1`): it can change between releases.
- Notifications are English-only. The UI is translated, Hungarian included
  (`client/src/locales/hu.json`).
- Its HTTP API is not a stable public surface. We would only use the documented plugin contract,
  never internal endpoints.

## The seam: a source plugin

BookOrbit ships no indexer. Sources are Torznab/Newznab or hand-written `.mjs` plugins loaded into
the server process. A plugin that serves a plain file (LibriVox, Gutenberg style) implements
`resolveFile()`, which returns a URL and BookOrbit downloads it itself into its Library Dock.

Contract (from `packages/plugin-api/src/index.ts` and
`server/src/modules/book-request/indexers/plugins/plugin-shape.ts`):

```js
export default {
  apiVersion: 1,
  type: "annas-archive",          // slug, ^[a-z0-9][a-z0-9-]{0,29}$
  label: "Anna's Archive",
  version: "1.0.0",
  mediaKinds: ["ebook"],
  requiresCredential: true,
  credentialKind: "apiKey",
  seedsBack: false,
  usesCategories: false,
  defaultBaseUrl: "https://annas.1000110.xyz",
  async test(config, host) { /* GET /plugin/test */ },
  async search(query, config, host) { /* GET /plugin/search */ },
  async resolveFile(release, config, host) {
    return { url, fileName, sizeBytes, format };   // BookOrbit fetches this itself
  },
}
```

`search()` receives a normalised query (`title`, `author`, `isbn13`, `language`, `mediaKind`,
`limit`) and returns candidates: `guid` and `title` are required, then `bookTitle`, `author`,
`format`, `language`, `sizeBytes`, `infoUrl`, all of which feed BookOrbit's own scoring. Every
network call must go through `host.fetch` (address checks, 25 s per request, 16 MB body).

Two numbers from `server/src/modules/book-request/fulfillment/direct-download.service.ts` matter:
30 s to get response headers, then 120 s of silence before the transfer is treated as dead. Anna's
Archive's free "slow download" has a ~41 s countdown, so a grab endpoint must send headers
immediately and only then wait.

## What we would add

`annas-archive/web` stays one container with the parsers, the cookie store and the Chromium mint.
Three routes for BookOrbit (device sync and the Hungarian pages are not involved):

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /plugin/test` | `Authorization: Bearer <BOOKORBIT_PLUGIN_TOKEN>` | `{"ok": true, "clearance": "yes"}` |
| `GET /plugin/search?q=&lang=&limit=` | same | `[{guid, title, bookTitle, author, format, language, sizeBytes, infoUrl}]` |
| `GET /plugin/grab/<guid>/<sig>.<ext>` | HMAC in the URL, ~10 min | the file: Anna's Archive slow download, Libgen fallback |

- `guid` is `<md5>:<format>` so each format is a distinct release; order EPUB, AZW3, MOBI, PDF, so a
  release profile can prefer EPUB.
- `/plugin/grab` streams: Anna's Archive first, Libgen second. The HMAC makes the URL a capability,
  because BookOrbit fetches it without our headers.
- The clearance, cookie refresh and back-off stay exactly as they are today.

The plugin file lives at `annas-archive/bookorbit/annas-archive.mjs` and is installed once through
**Settings -> Server -> Requests -> Sources -> Install plugin**. It is uploaded from disk, not
fetched, so no signed update channel is needed.

## What would retire

Only after the new path works end to end: the Hungarian templates and static CSS, the queue pages,
`/search`, `/add`, `/queue`, `/files`, `/upload`, `/sync`, `/sync/ack`, `/opds`, and
`koplugin/annas-sync.koplugin` together with its tests. The parsers, `harvest.py`, the cookie store
and their tests stay.

## The stack

`bookorbit/`, modelled on the other code stacks:

- `app`: `ghcr.io/bookorbit/bookorbit` pinned to a version, on the `proxy` network, Traefik labels,
  no published host port.
- `postgres`: `pgvector/pgvector:pg18`, named volume, app data in a second volume.
- `BOOKS_HOST_PATH` and the Library Dock on the same local filesystem: BookOrbit explicitly does not
  support SMB/NFS/FUSE or any network storage.
- Required env: `APP_URL`, `POSTGRES_*`, `JWT_SECRET`, `SETUP_BOOTSTRAP_TOKEN`,
  `BOOK_REQUEST_ENCRYPTION_KEY` (a source credential cannot be saved without it), `PUID`/`PGID`.
- Manifest entry with `auto: true` only once it runs.

## Steps

1. **Spike.** Stand up the stack on `library.1000110.xyz`, create the admin, one library, upload two
   books, log in with Pocket ID (issuer `https://id.1000110.xyz`, redirect
   `https://library.1000110.xyz/oauth2-callback`), switch the UI to Hungarian, install BookOrbit's
   KOReader plugin on the Paperwhite, download one book, check that progress syncs. The annas stack
   is untouched.
2. **Source.** The three routes with pytest (search mapping, missing and expired HMAC, headers before
   the countdown), the `.mjs` plugin, one indexer row, Test connection, a manual release search, one
   grab filed into the library.
3. **Requests.** Her account gets `book_request_access` and `book_request_auto_approve`; the owner
   keeps `manage_book_requests`; automatic downloads on with minimum score 80; one release profile
   (EPUB first, then AZW3/MOBI/PDF); a default destination library; import checks on. Then a real
   request from her phone, ending in the book being filed and a notification.
4. **Cutover.** BookOrbit to `books.1000110.xyz`, the downloader to `annas.1000110.xyz` (no redirect),
   the retirement list above removed, docs and Pocket ID updated (client `BookOrbit`, group `books`
   -> Request books).
5. **Kindle.** BookOrbit's plugin as the delivery path; progress sync is automatic, new arrivals need
   one tap ("Not on device" -> bulk download). Only if zero-tap turns out to matter, add something for
   it - not before the rest exists.

## Open questions

1. Subdomains: BookOrbit on `books.` (her bookmark, recommended) with the downloader on `annas.`, or
   BookOrbit on `library.` and leave `books.` alone?
2. Her requests auto-approved, or does the owner approve each one?
3. Free disk on the server (`df -h /`) and roughly how large the library may grow.
4. Is one tap in the KOReader catalog acceptable for delivery, or must new books appear with no tap?
5. Keep the Hungarian phone page for a couple of weeks as a fallback, or remove it at cutover?

## Why not the obvious alternatives

- **Send-to-Kindle by email**: Amazon converts to DRM'd KFX, which KOReader cannot open. It would
  break her reading setup.
- **Library Dock only** (drop files from our worker into a folder): works for ingestion, but the
  request queue would still need a human to close each request against the file. The plugin is what
  makes a request finish by itself.
- **Keep `annas-sync.koplugin` as the Kindle path**: it polls our `/sync`, not BookOrbit, so it would
  deliver a second library alongside the one she browses. Two catalogues and two progress states is
  worse than one tap.
- **Write the Anna's Archive scraping in JavaScript** so the plugin is self-contained: throws away
  parsers tested against real saved pages and a Chromium mint that already works. The service is the
  cheaper half to keep.

## Verified on 2026-11-21

- Plugin contract, loader checks, direct-download timeouts and the Library Dock flow: read from the
  `bookorbit/bookorbit` source (`packages/plugin-api`, `server/src/modules/book-request/**`,
  `client/src/locales/hu.json`).
- Requests page, Library Dock, KOReader plugin, OIDC/Pocket ID and installation: from
  `bookorbit.app` docs.
- Cannot be tried from this machine: no Docker and no Node locally, and no SSH to the VPS (deploy key
  lives in CI). The spike has to go through the stack deploy pipeline.