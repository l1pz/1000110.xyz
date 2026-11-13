# ruminant

A small language model thinking out loud, streamed to the site (`/api/ruminant`). Source imported from the server on
2026-11-01 (it was only ever on the server); deployed to `/opt/stacks/ruminant/`.

Server-only, never in git (the deploy copies tracked files only and deletes nothing):
- `models/`: the GGUF model files (about 5 GB), mounted read-only at `/models`.
- `llama/`: a `llama-server` build (recent llama.cpp, needed for Gemma 4) plus its `lib/`; the Dockerfile copies it in.
- `data/`: `state.json`.

Rebuild after a change: `docker compose up -d --build` (the deploy job does it).

**Disabled (2026-11-13).** The container is stopped, has no restart policy and no Traefik route, and the stack is not in `stacks/manifest.json`, so CI never deploys it. The OOM killer stopped `llama-server` three times in 3 days (Nov 11, 12, 13) at the 5 GiB `mem_limit`. To bring it back: add the stack to the manifest, restore `restart: unless-stopped` and `traefik.enable=true`, raise `mem_limit` (about 7g) and find the slow memory growth first.
