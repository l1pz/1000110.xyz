# sc2bp

The service behind the `sc2bp` tool (`/tools/#sc2bp`): lists a SoundCloud playlist, searches Beatport, creates the Beatport playlist. Owner only: Traefik puts the `tinyauth` forward auth in front of `/api/sc2bp`, and tinyauth is only ever used by the owner. The browser does all the matching; this service only fetches and acts.

## Routes (`/api/sc2bp`)
- `GET /health`, `GET /me` (a 200 through Traefik means the visitor is logged in)
- `POST /playlist {url}` gives `{name, urls}`: the track links, fast (`yt-dlp --flat-playlist`; only https soundcloud.com links; at most 300 tracks). A flat listing has no titles, so:
- `POST /tracks {urls}` (at most 10) gives `{tracks: [{title, uploader, durationSec}]}` in the same order, resolved in parallel (about a second per track, `formats` skipped); a private or deleted track comes back with an empty title. Links must be soundcloud.com pages or the exact `api(-v2).soundcloud.com/tracks/<id>` form the listing uses.
- `POST /search {queries}` (at most 10) gives `{results: [[candidate]]}`; a candidate is `{id, title, mix, artists, durationSec}`
- `POST /create {name, ids}` gives `{name, added, url}`

## Deploy (by hand, like Ruminant)
1. Copy this folder to `/opt/stacks/sc2bp/` (without `tests/`).
2. `mkdir data && chown 10002 data` (the container user), and create `.env` (mode 600) with `BEATPORT_USERNAME=` and `BEATPORT_PASSWORD=`. Never commit it. Compose reads `$` in an `.env` value as a variable: if the password has `$` followed by letters or `{`, wrap the value in single quotes (`BEATPORT_PASSWORD='pa$$word'`). Check the length inside the container with `docker exec sc2bp python -c "import os; print(len(os.environ['BEATPORT_PASSWORD']))"` (never print the value).
3. `docker compose up -d --build`.

## Maintenance
- **yt-dlp breaks when SoundCloud changes.** Rebuild to get the newest release: `docker compose build --no-cache && docker compose up -d`.
- **Beatport has no public API.** `beatport.py` borrows the public `client_id` from `https://api.beatport.com/v4/docs/` and logs in as the owner (the same flow as the beets-beatport4 plugin; playlist calls as in beatport-mcp). It is a ToS grey area, accepted for personal use, and it can break whenever Beatport changes that page or the flow. The token is cached in `data/token.json` (mode 600) and refreshed; a refused token triggers one fresh login.
- Beatport calls are spaced at least 0.4 s apart.

## Tests
`pip install -r requirements-dev.txt`, then `pytest` in this folder. No network: Beatport is faked with `httpx.MockTransport`, `yt-dlp` with a fake runner. They are not part of `npm run check`.
