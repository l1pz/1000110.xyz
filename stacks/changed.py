"""Which stacks does a push to main deploy? (TASKS.md, Phase 3e task 3.) Standard library only: the CI job runs it before
anything is installed.

    python stacks/changed.py --before <sha> --sha <sha> [--stack <name>]

Prints two lines for `$GITHUB_OUTPUT`: `matrix={"include": [{"stack": ..., "approval": ...}]}` and `any=true|false`.
A stack is picked when it has `"auto": true` in the manifest and a file that is actually copied to the server (the
same `include` rule as the deploy) changed in `before..sha`. `--stack` (the manual dispatch) picks exactly that stack,
whatever its `auto` says: the server's own allowlist is the gate. The order is the manifest's order.
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ZEROS = "0" * 40


def deployed(entry: dict, rel: str) -> bool:
    """Is `rel` (a path inside the stack's source folder) copied to the server? Same rule as `lint.tracked_files`
    (a test keeps the two equal): `include` globs, where `*` does not cross a folder; no `include` means every file."""
    include = entry.get("include")
    return include is None or any(rel.count("/") == g.count("/") and fnmatch.fnmatchcase(rel, g) for g in include)


def touched(entry: dict, changed: list[str]) -> bool:
    src = entry["source"].rstrip("/") + "/"
    return any(path.startswith(src) and deployed(entry, path[len(src) :]) for path in changed)


def pick(manifest: dict, changed: list[str], forced: str | None = None) -> list[dict]:
    stacks = manifest.get("stacks", {})
    if forced:
        if forced not in stacks:
            raise SystemExit(f"stack {forced!r} is not in stacks/manifest.json")
        return [{"stack": forced, "approval": bool(stacks[forced].get("approval"))}]
    return [
        {"stack": name, "approval": bool(entry.get("approval"))}
        for name, entry in stacks.items()
        if entry.get("auto") is True and touched(entry, changed)
    ]


def changed_paths(root: Path, before: str, sha: str) -> list[str]:
    """Files changed in `before..sha`. A missing, all-zero or unknown `before` (first push, force push) falls back to
    the changes of the single commit `sha`."""
    def git(*args: str) -> subprocess.CompletedProcess:
        return subprocess.run(["git", *args], cwd=root, capture_output=True, text=True)

    base = before if before and before != ZEROS and git("cat-file", "-e", f"{before}^{{commit}}").returncode == 0 else f"{sha}^"
    done = git("diff", "--name-only", f"{base}..{sha}")
    if done.returncode != 0:
        raise SystemExit(f"git diff {base}..{sha} failed: {done.stderr.strip()}")
    return [line for line in done.stdout.splitlines() if line]


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--before", default="")
    ap.add_argument("--sha", required=True)
    ap.add_argument("--stack", default="")
    args = ap.parse_args(argv)
    manifest = json.loads((ROOT / "stacks" / "manifest.json").read_text(encoding="utf-8"))
    changed = [] if args.stack else changed_paths(ROOT, args.before, args.sha)
    chosen = pick(manifest, changed, args.stack or None)
    print(f"matrix={json.dumps({'include': chosen})}")
    print(f"any={'true' if chosen else 'false'}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
