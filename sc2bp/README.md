# sc2bp

The service behind the `sc2bp` tool (`/tools/#sc2bp`): converts a SoundCloud playlist into a Beatport playlist, as background jobs that go on with the page closed. Owner only: Traefik puts the `tinyauth` forward auth in front of `/api/sc2bp`, and tinyauth is only ever used by the owner.

## How a job runs
One worker runs one job at a time (the rest wait in the queue, at most 20 active jobs). Each phase only does what is still undone, so a restart, a pause or a retry carries on from the last save:

1. **listing**: `yt-dlp --flat-playlist` gives the track links (up to 1000 tracks).
2. **reading**: the links are resolved 10 at a time (title, uploader, length). A track that comes back blank is read once more at the end; if it is still blank it is `unreadable` (private or deleted) and never fails the job.
3. **matching**: each track is searched on Beatport and scored by `parse.py` and `match.py`: `match` (confident, picked at once), `maybe` or `none` (left for the optional review).
4. **creating**: the Beatport playlist is made from the picked tracks, and they are added 50 at a time. The playlist id is saved the moment it exists, so a restart never makes a second playlist.

A job is saved to `/data/jobs/<id>.json` (written to a temp file and renamed) after every batch, and every 5 searches or 2 seconds while matching, so a crash costs a couple of searches at most. After a restart a job that was running is queued again.

**Errors are sorted:**
- a Beatport search that fails for one track marks that track `error` and the job goes on; three tracks failing in a row pause the job;
- rate limits (429, `Retry-After` is respected), server errors and lost connections are retried after 5, 15, 45, 120 and 300 seconds, then the job is `paused`;
- anything that needs the owner (login refused, private playlist) stops the job as `failed` with the reason;
- `retry` carries on a failed, paused or cancelled job, or retries the `error` tracks of a finished one.

## Routes (`/api/sc2bp`)
- `GET /health`, `GET /me` (a 200 through Traefik means the visitor is logged in)
- `POST /jobs {url, name?}` starts a job; a link already being converted gives that job back (`created: false`)
- `GET /jobs`, `GET /jobs/{id}`: state, phase, progress, counts, waiting (a retry countdown), error, the Beatport playlist
- `GET /jobs/{id}/tracks?filter=unmatched|maybe|none|error|unreadable|picked|all&offset=&limit=` for the review
- `POST /jobs/{id}/cancel`, `/retry`, `/apply` (add the tracks picked since the playlist was made), `DELETE /jobs/{id}` (the record only, never the Beatport playlist)
- `POST /jobs/{id}/tracks/{index}/pick {id|null}` picks one of the suggestions (or undoes the pick)
- `POST /jobs/{id}/tracks/{index}/search {query}` searches Beatport by hand and offers the results

## Deploy (by hand, like Ruminant)
1. Copy this folder to `/opt/stacks/sc2bp/` (without `tests/`).
2. `mkdir data && chmod 2777 data`, and create `.env` (mode 600) with `BEATPORT_USERNAME=` and `BEATPORT_PASSWORD=`. Never commit it. Compose reads `$` in an `.env` value as a variable: if the password has `$` followed by letters or `{`, wrap the value in single quotes (`BEATPORT_PASSWORD='pa$$word'`). Check the length inside the container with `docker exec sc2bp python -c "import os; print(len(os.environ['BEATPORT_PASSWORD']))"` (never print the value).
3. `docker compose up -d --build`.

## Maintenance
- **yt-dlp breaks when SoundCloud changes.** Rebuild to get the newest release: `docker compose build --no-cache && docker compose up -d`. A broken `yt-dlp` shows up as failed or paused jobs with a message; nothing is lost.
- **Beatport has no public API.** `beatport.py` borrows the public `client_id` from `https://api.beatport.com/v4/docs/` and logs in as the owner (the same flow as the beets-beatport4 plugin; playlist calls as in beatport-mcp). It is a ToS grey area, accepted for personal use, and it can break whenever Beatport changes that page or the flow. The token is cached in `data/token.json` (mode 600) and refreshed; a refused token triggers one fresh login. Beatport calls are spaced at least 0.4 s apart.
- **Jobs pile up** in `data/jobs/`; delete finished ones from the tool.
- Known edge: if the server dies in the instant between Beatport taking a batch of tracks and the job saving that fact, that batch is sent again on resume and Beatport may list those tracks twice.

## Tests
`pip install -r requirements-dev.txt`, then `pytest` in this folder (CI runs it too). No network: Beatport is faked with `httpx.MockTransport` or a fake client, `yt-dlp` with a fake runner. `tests/fixtures/real_playlist.json` holds 30 real tracks with their real Beatport results and `real_expected.json` what the matching decided; they pin the scoring.
