# stacks

Every service on the server as code (TASKS.md, Phase 3e). `manifest.json` maps each stack name to the repo folder with
its `compose.yaml` (`source`), where it lives on the server (`target`) and optionally which files are copied
(`include`; default every tracked file, nothing is deleted on the server). Infrastructure stacks live here; code
stacks stay next to their code (`kuma/`, `sc2bp/`, `ruminant/`).

Never in git: `.env` files (each has an `.env.example` with the key names), `data/`, `models/`, `dist/`,
`letsencrypt/`, worlds. They stay on the server.

`lint.py` checks every compose file against `policy.json` and runs in CI (`python stacks/lint.py`; tests with
`python -m pytest` in this folder, after `pip install -r requirements-dev.txt`). A dangerous setting (docker socket,
published ports, floating image tags, missing `no-new-privileges` or `mem_limit`, privileged, host namespaces,
devices, capabilities, host mounts) fails unless `policy.json` lists it with a reason; an exception that matches
nothing fails too, so fixing a risk means deleting its line.

Not managed yet: `_template/` is a copy-me folder for a new static site, not a stack.
