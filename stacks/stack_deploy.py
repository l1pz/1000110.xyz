#!/usr/bin/env python3
"""Applies one stack of the repo to the server (TASKS.md, Phase 3e). Runs as root, through sudo, from the forced
command of the CI key (`stack-deploy-ssh`), so the only things the key can do are:

    <stack> <40 hex commit>          deploy that stack at that commit
    plan <stack> <40 hex commit>     show what a deploy would change and recreate, change nothing

What it checks, in order (each failure stops before anything on the server changes):
  1. the request is exactly that shape and the stack is in the server's own allowlist (/etc/stack-deploy/stacks);
  2. the commit is an ancestor of origin/main (fetched with a read-only deploy key), so a leaked CI key cannot deploy
     a branch or a pull request;
  3. `stacks/lint.py` passes on that commit and the stack's `target` equals the allowlist's;
  4. `docker compose config` accepts the compose file with the server's `.env`.
Then it copies the stack's tracked files (never `.env`, data or anything else, nothing is deleted; replaced files are
kept in `.stack-deploy-prev/`), runs `docker compose up -d --build --remove-orphans` and waits until every service
is running (and healthy, when it has a health check). Output goes to the caller and to the log.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

try:
    import fcntl
except ImportError:  # Windows: only the tests run there
    fcntl = None  # type: ignore[assignment]

REQUEST = re.compile(r"^(?P<plan>plan )?(?P<stack>[a-z0-9]+(-[a-z0-9]+)*) (?P<sha>[0-9a-f]{40})$")
EXIT_REFUSED, EXIT_INVALID, EXIT_FAILED = 2, 3, 4


class Refused(Exception):
    """The request must not run (bad shape, unknown stack, commit not on main)."""

    code = EXIT_REFUSED


class Invalid(Refused):
    """The commit is on main but its stack does not pass lint or `docker compose config`."""

    code = EXIT_INVALID


class Failed(Refused):
    """The deploy ran and did not come up healthy."""

    code = EXIT_FAILED


@dataclass
class Config:
    conf_dir: Path = Path("/etc/stack-deploy")
    state_dir: Path = Path("/var/lib/stack-deploy")
    repo_url: str = "git@github.com:l1pz/1000110.xyz.git"
    branch: str = "main"
    health_timeout: float = 180.0
    health_interval: float = 3.0
    #: Where the targets really are (`/` on the server; a temp folder in tests).
    fs_root: Path = Path("/")

    def fs(self, target: str) -> Path:
        return self.fs_root / target.lstrip("/")

    @property
    def repo(self) -> Path:
        return self.state_dir / "repo"

    @property
    def git_env(self) -> dict[str, str]:
        key, hosts = self.conf_dir / "repo_key", self.conf_dir / "known_hosts"
        ssh = f"ssh -i {key} -o IdentitiesOnly=yes -o UserKnownHostsFile={hosts} -o StrictHostKeyChecking=yes"
        return {"GIT_SSH_COMMAND": ssh}


class Runner:
    """Every git and docker call goes through here, so tests can fake docker."""

    def run(self, cmd: list[str], cwd: Path | None = None, env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
        return subprocess.run(cmd, cwd=cwd, env={**os.environ, **(env or {})}, capture_output=True, text=True)


@dataclass
class Deploy:
    cfg: Config
    runner: Runner
    out: list[str] = field(default_factory=list)

    def say(self, text: str) -> None:
        self.out.append(text)
        print(text, flush=True)

    def run(self, cmd: list[str], cwd: Path | None = None, env: dict[str, str] | None = None, what: str = "") -> subprocess.CompletedProcess:
        done = self.runner.run(cmd, cwd=cwd, env=env)
        if done.returncode != 0:
            detail = (done.stderr or done.stdout or "").strip()
            raise Refused(f"{what or ' '.join(cmd[:3])} failed: {detail[-1500:]}")
        return done


def parse_request(text: str) -> tuple[bool, str, str]:
    m = REQUEST.match(text.strip())
    if not m:
        raise Refused("request must be `[plan ]<stack> <40 hex commit>`")
    return bool(m["plan"]), m["stack"], m["sha"]


def read_allowlist(conf_dir: Path) -> dict[str, str]:
    """`name /opt/target` lines, `#` comments. Owned by root: adding a stack is an owner step on the server."""
    allowed: dict[str, str] = {}
    path = conf_dir / "stacks"
    if not path.is_file():
        raise Refused(f"{path} does not exist: no stack is allowed")
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if line:
            name, target = line.split()
            allowed[name] = target
    return allowed


def checkout(d: Deploy, sha: str) -> Path:
    cfg, repo = d.cfg, d.cfg.repo
    if not (repo / ".git").is_dir():
        cfg.state_dir.mkdir(parents=True, exist_ok=True)
        d.run(["git", "clone", "--quiet", cfg.repo_url, str(repo)], env=cfg.git_env, what="git clone")
    d.run(["git", "fetch", "--quiet", "--prune", "origin", cfg.branch], cwd=repo, env=cfg.git_env, what="git fetch")
    known = d.runner.run(["git", "cat-file", "-e", f"{sha}^{{commit}}"], cwd=repo)
    if known.returncode != 0:
        raise Refused(f"commit {sha[:10]} is not in the repository")
    on_main = d.runner.run(["git", "merge-base", "--is-ancestor", sha, f"origin/{cfg.branch}"], cwd=repo)
    if on_main.returncode != 0:
        raise Refused(f"commit {sha[:10]} is not on {cfg.branch}: refusing to deploy it")
    d.run(["git", "checkout", "--quiet", "--detach", "--force", sha], cwd=repo, what="git checkout")
    d.run(["git", "clean", "-fdxq"], cwd=repo, what="git clean")
    return repo


def load_lint(root: Path):
    spec = importlib.util.spec_from_file_location("stacks_lint", root / "stacks" / "lint.py")
    if spec is None or spec.loader is None:
        raise Refused("stacks/lint.py is missing in that commit")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module  # dataclasses look their module up here
    spec.loader.exec_module(module)
    return module


@dataclass
class Change:
    rel: str
    new: bool


def changes(root: Path, entry: dict, files: list[str], target: Path) -> list[Change]:
    out = []
    for rel in files:
        dest = target / rel
        src = root / entry["source"] / rel
        if not dest.is_file():
            out.append(Change(rel, True))
        elif dest.read_bytes() != src.read_bytes():
            out.append(Change(rel, False))
    return out


def compose_cmd(target: Path, compose_file: Path, *args: str) -> list[str]:
    cmd = ["docker", "compose", "--project-directory", str(target), "-f", str(compose_file)]
    return cmd + list(args)


def apply_files(root: Path, entry: dict, todo: list[Change], target: Path) -> None:
    st = target.stat()
    prev = target / ".stack-deploy-prev"
    for c in todo:
        src, dest = root / entry["source"] / c.rel, target / c.rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        if not c.new:
            (prev / c.rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(dest, prev / c.rel)
        tmp = dest.with_name(f".{dest.name}.deploy-tmp")
        shutil.copyfile(src, tmp)
        executable = bool(src.stat().st_mode & 0o100)
        tmp.chmod(0o775 if executable else 0o664)
        if hasattr(os, "chown"):
            os.chown(tmp, st.st_uid, st.st_gid)
        os.replace(tmp, dest)


def wait_healthy(d: Deploy, target: Path) -> None:
    compose = target / "compose.yaml"
    deadline = time.monotonic() + d.cfg.health_timeout
    state = "no containers"
    while True:
        done = d.runner.run(compose_cmd(target, compose, "ps", "--all", "--format", "json"), cwd=target)
        rows = [json.loads(line) for line in done.stdout.splitlines() if line.strip().startswith("{")]
        bad = [f"{r.get('Service')}: {r.get('State')}{' ' + r['Health'] if r.get('Health') else ''}" for r in rows if r.get("State") != "running" or r.get("Health") not in (None, "", "healthy")]
        state = "; ".join(bad) if bad or rows else state
        if rows and not bad:
            return
        if time.monotonic() >= deadline:
            logs = d.runner.run(compose_cmd(target, compose, "logs", "--no-color", "--tail", "30"), cwd=target)
            d.say((logs.stdout or logs.stderr).strip()[-2000:])
            raise Failed(f"not healthy after {int(d.cfg.health_timeout)} s: {state}")
        time.sleep(d.cfg.health_interval)


def deploy(d: Deploy, request: str) -> None:
    cfg, runner = d.cfg, d.runner
    plan_only, stack, sha = parse_request(request)
    allowed = read_allowlist(cfg.conf_dir)
    if stack not in allowed:
        raise Refused(f"stack {stack!r} is not in {cfg.conf_dir / 'stacks'}")
    root = checkout(d, sha)
    lint = load_lint(root)
    problems = lint.lint_all(root)
    if problems:
        raise Invalid("lint failed:\n  " + "\n  ".join(problems))
    manifest = json.loads((root / "stacks" / "manifest.json").read_text(encoding="utf-8"))
    entry = manifest["stacks"].get(stack)
    if entry is None:
        raise Invalid(f"stack {stack!r} is not in stacks/manifest.json at {sha[:10]}")
    if entry["target"] != allowed[stack]:
        raise Invalid(f"manifest target {entry['target']} differs from the server's {allowed[stack]}")
    target = cfg.fs(entry["target"])
    files = lint.tracked_files(root, entry)
    todo = changes(root, entry, files, target) if target.is_dir() else [Change(r, True) for r in files]
    staged = root / entry["source"] / "compose.yaml"
    env_args = ["--env-file", str(target / ".env")] if (target / ".env").is_file() else []
    project_dir = target if target.is_dir() else root / entry["source"]
    config = runner.run(compose_cmd(project_dir, staged, *env_args, "config", "-q"), cwd=root / entry["source"])
    if config.returncode != 0:
        raise Invalid(f"docker compose config failed: {(config.stderr or config.stdout).strip()[-1500:]}")
    d.say(f"{stack} @ {sha[:10]}: {len(todo)} file(s) differ" + "".join(f"\n  {'+' if c.new else '~'} {c.rel}" for c in todo))
    if plan_only:
        dry = runner.run(compose_cmd(project_dir, staged, *env_args, "--dry-run", "up", "-d", "--no-build", "--remove-orphans"), cwd=root / entry["source"])
        d.say("docker compose would do:\n" + (dry.stderr + dry.stdout).strip()[-2500:])
        return
    target.mkdir(parents=True, exist_ok=True)
    apply_files(root, entry, todo, target)
    up = runner.run(compose_cmd(target, target / "compose.yaml", "up", "-d", "--build", "--remove-orphans"), cwd=target)
    d.say((up.stderr + up.stdout).strip()[-2500:])
    if up.returncode != 0:
        raise Failed("docker compose up failed (the previous files are in .stack-deploy-prev/)")
    wait_healthy(d, target)
    d.say(f"{stack}: up and healthy")


def main(argv: list[str], cfg: Config | None = None, runner: Runner | None = None) -> int:
    cfg = cfg or Config()
    request = " ".join(argv)
    cfg.state_dir.mkdir(parents=True, exist_ok=True)
    log = cfg.state_dir / "deploy.log"
    with open(cfg.state_dir / "lock", "w") as lock:
        if fcntl:
            fcntl.flock(lock, fcntl.LOCK_EX)  # one deploy at a time; a second caller waits
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")
        d = Deploy(cfg, runner or Runner())
        try:
            deploy(d, request)
            code, tail = 0, "ok"
        except Refused as error:
            print(f"stack-deploy: {error}", file=sys.stderr, flush=True)
            code, tail = error.code, f"refused/failed ({error.code}): {error}"
        with open(log, "a", encoding="utf-8") as f:
            f.write(f"{stamp} {request!r} {tail}\n")
            for line in d.out:
                f.write(f"    {line}\n")
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
