# sc2bp

The service behind the `sc2bp` tool (`/tools/#sc2bp`): converts a SoundCloud or YouTube (Music) playlist into a Beatport playlist, as background jobs that go on with the page closed. Owner only: Traefik puts the `tinyauth` forward auth in front of `/api/sc2bp`, and tinyauth is only ever used by the owner.

## Sources
`sources.py` picks the source by the link's host and each job remembers it (`job["source"]`; jobs saved before YouTube existed count as SoundCloud). A source is a module with `check_url`, `list_playlist` and `read_tracks`.
- **SoundCloud** (`soundcloud.py`): the listing has links only, so the reading phase resolves titles.
- **YouTube and YouTube Music** (`youtube.py`): `youtube.com`, `m.`, `music.youtube.com` and `youtu.be` links that carry `list=`; a bare video link is refused. Every link is rewritten to `https://www.youtube.com/playlist?list=<id>`, so the same playlist is one job whichever form it was pasted in. The flat listing already has title, channel and length, so **there is no reading phase**: tracks go from listing straight to matching. `parse.py` strips the video dressing from YouTube titles only (`(Official Video)`, `(Video Oficial)`, `| Official Visualiser`, `OFFICIAL MUSIC VIDEO`; a mix such as `(Extended Video Mix)` stays; `(with X)` becomes featuring). A `Name - Topic` channel (YouTube Music's own uploads) is the artist, not a guess. Private and deleted videos are `unreadable`.

## How a job runs
One worker runs one job at a time (the rest wait in the queue, at most 20 active jobs). Each phase only does what is still undone, so a restart, a pause or a retry carries on from the last save:

1. **listing**: `yt-dlp --flat-playlist` gives the track links (up to 2000 tracks).
2. **reading** (SoundCloud only): the links are resolved 10 at a time (title, uploader, length). A track that comes back blank is read once more at the end; if it is still blank it is `unreadable` (private or deleted) and never fails the job.
3. **matching**: each track is searched on Beatport and scored by `parse.py` and `match.py`: `match` (confident, picked at once), `maybe` or `none` (left for the optional review).
4. **creating**: the Beatport playlist is made from the picked tracks, and they are added 50 at a time. The playlist id is saved the moment it exists, so a restart never makes a second playlist.

**Split playlists.** A job has a `split` (tracks per playlist; the tool's form sends 100, the API default is 0 = one playlist). With a split, playlists are named `Name #1`, `Name #2`, ... and hold at most `split` tracks each. Picked tracks fill them in source order; `Runner._assign` decides each track's playlist (`track["list"]`) and saves it before anything is added, so a restart adds the same tracks to the same playlists. A track picked later in the review goes to the first playlist with room, or starts the next one. Two source tracks that found the same Beatport track share one place. A job saved before this (one `playlist`) loads as a single playlist.

A job is saved to `/data/jobs/<id>.json` (written to a temp file and renamed) after every batch, and every 5 searches or 2 seconds while matching, so a crash costs a couple of searches at most. After a restart a job that was running is queued again.

**Errors are sorted:**
- a Beatport search that fails for one track marks that track `error` and the job goes on; three tracks failing in a row pause the job;
- rate limits (429, `Retry-After` is respected), server errors and lost connections are retried after 5, 15, 45, 120 and 300 seconds, then the job is `paused`;
- anything that needs the owner (login refused, private playlist) stops the job as `failed` with the reason;
- `retry` carries on a failed, paused or cancelled job, or retries the `error` tracks of a finished one.

## Routes (`/api/sc2bp`)
- `GET /health`, `GET /me` (a 200 through Traefik means the visitor is logged in)
- `POST /jobs {url, name?, split?}` starts a job (`split` 0 to 2000); a link already being converted gives that job back (`created: false`)
- `GET /jobs`, `GET /jobs/{id}`: state, phase, progress, counts, waiting (a retry countdown), error, the Beatport playlist
- `GET /jobs/{id}/tracks?filter=unmatched|maybe|none|error|unreadable|picked|all&offset=&limit=` for the review
- `POST /jobs/{id}/cancel`, `/retry`, `/apply` (add the tracks picked since the playlist was made), `DELETE /jobs/{id}` (the record only, never the Beatport playlist)
- `POST /jobs/{id}/tracks/{index}/pick {id|null}` picks one of the suggestions (or undoes the pick)
- `POST /jobs/{id}/tracks/{index}/search {query}` searches Beatport by hand and offers the results

## Liked-music sync (`syncer.py`, `sync_routes.py`, routes under `/api/sc2bp/sync`)
Keeps a YouTube playlist (default: Liked music, `list=LM`) filed into Beatport playlists grouped by genre, nightly and on a button. The tool for it is `/tools/#sync` (a later PR); everything below already works over the API.

**Rules.** It only adds: nothing is removed from Beatport, an unliked song stays, a track the owner deletes from a playlist is remembered as `dismissed` and never added back. What is filed is decided by reading the Beatport playlists, never by the add call's answer: after adding, the playlist is read again, present means `filed`, absent means `unavailable` (tried again after 30 days, at most 3 times). Every phase can run twice with the same result, so a crash or a restart just carries on.

**Playlists** are named `<prefix> - <Group> #<n>` (default `Liked - Techno #1`), at most `cap` tracks each (default 100), oldest likes first, and found again by that name if the state is lost. Groups are Beatport genres merged into families (`DEFAULT_GROUPS` in `syncer.py`, editable through `PUT /config`); a genre no group lists goes to `Other`. Genres can move between groups any time; a group with playlists cannot be renamed or removed (its name is in the playlist names).

**A run** (one at a time): `youtube` (list the likes with the cookie file; an empty list, or fewer than half the known likes, is refused as "looks wrong" and changes nothing) → `beatport` (find the group playlists, read what is in them) → `plan` (what is filed, dismissed, or held because its playlist vanished) → `match` (search Beatport for new likes only; not-found tracks are tried again after 14 days, 3 times in all) → preview → `file`. The **first** run stops at a preview ("add 640 tracks, create 8 playlists") and goes on only after `POST /run/{id}/confirm`; after one good run, nightly runs never wait. A playlist that vanished from Beatport is never refilled by itself: it shows up in the `gone` inbox and the owner chooses `recreate` or `forget`.

**State** is two files in `/data/sync/`: `config.json` and `state.json` (written to a temp file and renamed; `state.json.bak` is the copy from the start of the last run). A file that cannot be read stops the sync (health `broken`) and is never overwritten.

**Nightly**: `config.nightly` (off by default; 04:30 `Europe/Budapest`). Runs once per night slot, catches up once after downtime, retries a failed night once after 6 hours, and never retries expired cookies in a loop. It only starts after a first good run.

**Health** `GET /sync/health` answers 200 (also before anything is set up, so a fresh deploy does not alert) or 503 when the owner has to act: `needs-cookies`, `failed` (the last run), `stale` (nightly on and no good run for 36 hours) or `broken`. The Kuma monitor `sync` watches it (`kuma/monitors.json`; add it with `provision.sh` after the deploy).

**First use**: `POST /import-job {"jobId": "<finished conversion of the same playlist>"}` reuses that conversion's matches and the owner's picks (no searching again), `POST /run`, read the preview, `POST /run/{id}/confirm`. The old count-split playlists are not touched and not looked at.

Routes: `GET /` (status, config, groups, counts, health), `POST /run`, `POST /run/{id}/confirm|cancel`, `GET /runs`, `GET /runs/{id}`, `GET /inbox?filter=review|notfound|unavailable|skipped|gone`, `POST /videos/{id}/pick|search|skip|restore|group`, `PUT /config`, `POST /import-job`, `POST /gone`, `GET /health`.

## Deploy (by hand, like Ruminant)
1. Copy this folder to `/opt/stacks/sc2bp/` (without `tests/`).
2. `mkdir data && chmod 2777 data`, and create `.env` (mode 600) with `BEATPORT_USERNAME=` and `BEATPORT_PASSWORD=`. Never commit it. Compose reads `$` in an `.env` value as a variable: if the password has `$` followed by letters or `{`, wrap the value in single quotes (`BEATPORT_PASSWORD='pa$$word'`). Check the length inside the container with `docker exec sc2bp python -c "import os; print(len(os.environ['BEATPORT_PASSWORD']))"` (never print the value).
3. `docker compose up -d --build`.

## YouTube cookies (private playlists, "Liked music")
Public and unlisted playlists need nothing. For a private one, put a Netscape-format `cookies.txt` at `/opt/stacks/sc2bp/data/youtube-cookies.txt` (`chown 10002`, mode 600); it is used whenever the file exists and is never in git (`data/` is backed up). Use a **throwaway Google account**: Google can flag an account whose cookies are used from a server. Export from a private browser window logged into only that account (a "Get cookies.txt" extension, on youtube.com, then close the window so the session is not rotated). When they expire the job fails with "that playlist is private or gone ... cookies ... missing or expired"; replace the file and `retry`. yt-dlp rewrites the file as it refreshes the cookies.

## Maintenance
- **yt-dlp breaks when SoundCloud or YouTube change.** Rebuild to get the newest release: `docker compose build --no-cache && docker compose up -d`. A broken `yt-dlp` shows up as failed or paused jobs with a message; nothing is lost.
- **Beatport has no public API.** `beatport.py` borrows the public `client_id` from `https://api.beatport.com/v4/docs/` and logs in as the owner (the same flow as the beets-beatport4 plugin; playlist calls as in beatport-mcp). It is a ToS grey area, accepted for personal use, and it can break whenever Beatport changes that page or the flow. The token is cached in `data/token.json` (mode 600) and refreshed; a refused token triggers one fresh login. Beatport calls are spaced at least 0.4 s apart.
- **Jobs pile up** in `data/jobs/`; delete finished ones from the tool.
- **Beatport's add answer is not the truth.** Measured on the real 1521-track conversion: of the 75 tracks the add call "refused", 49 were in the playlists, and 13 tracks it "took" were missing. `is_available_for_streaming` does not predict it either. So `Beatport.playlist_tracks()` (what is really in a playlist) is what the sync trusts; the conversion jobs still go by the add answer.
- Beatport calls beyond the conversion: `my_playlists()`, `playlist_tracks(id)` (every page, tombstones marked) and `tracks_by_ids(ids)` (batches of 50); every candidate now carries its `genre` and `subGenre`.
- Retrying lives in `resilience.py` (`retrying`, `BACKOFF_SECS`): 5, 15, 45, 120, 300 s, `Retry-After` honoured, then the caller pauses or fails.
- Known edge: if the server dies in the instant between Beatport taking a batch of tracks and the job saving that fact, that batch is sent again on resume and Beatport may list those tracks twice.

## Tests
`pip install -r requirements-dev.txt`, then `pytest` in this folder (CI runs it too). No network: Beatport is faked with `httpx.MockTransport` or a fake client, `yt-dlp` with a fake runner. `tests/fixtures/real_playlist.json` holds 30 real tracks with their real Beatport results and `real_expected.json` what the matching decided; they pin the scoring.
