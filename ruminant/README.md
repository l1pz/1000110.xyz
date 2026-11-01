# ruminant

A small language model thinking out loud, streamed to the site (`/api/ruminant`). Source imported from the server on
2026-11-01 (it was only ever on the server); deployed to `/opt/stacks/ruminant/`.

Server-only, never in git (the deploy copies tracked files only and deletes nothing):
- `models/`: the GGUF model files (about 5 GB), mounted read-only at `/models`.
- `llama/`: a `llama-server` build (recent llama.cpp, needed for Gemma 4) plus its `lib/`; the Dockerfile copies it in.
- `data/`: `state.json`.

Rebuild after a change: `docker compose up -d --build` (the deploy job does it).
