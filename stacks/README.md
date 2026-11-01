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

## Deploying
`stack_deploy.py` runs on the server as root (installed by `deploy/install-stack-deploy.sh`) and is only reachable through the CI key's forced command: `<stack> <40 hex commit>` deploys, `plan <stack> <commit>` shows the file changes and what `docker compose` would recreate without changing anything. Logs: `/var/lib/stack-deploy/deploy.log`. A new stack must first be added to `/etc/stack-deploy/stacks` by the owner (`--allow name=/opt/target` on the installer). Break-glass is still your own `mmate` login; replaced files are in `<target>/.stack-deploy-prev/`.

## CI
A push to `main` deploys every stack with `"auto": true` in `manifest.json` whose copied files changed (`changed.py`); stacks with `"approval": true` wait for the owner in GitHub. To deploy or retry one stack by hand: Actions > CI > Run workflow (branch `main`), `stack` = its name. Turning a stack on: the owner adds it to `/etc/stack-deploy/stacks` (`--allow name=/opt/target`), then a PR sets `auto`.
