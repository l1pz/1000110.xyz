"""Policy lint for the compose files of every managed stack (see TASKS.md, Phase 3e).

Runs in CI on every push and again on the server before a deploy. It rejects dangerous settings unless
`stacks/policy.json` lists the exception with a reason. An exception that no longer matches anything is an error too,
so removing a risk also means deleting its line.

    python stacks/lint.py            # lint everything in stacks/manifest.json, exit 1 on any finding
"""

from __future__ import annotations

import fnmatch
import json
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
NAME = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
LOOPBACK = {"127.0.0.1", "::1", "localhost"}
HOST_NAMESPACES = ("network_mode", "pid", "ipc", "userns_mode", "uts")


class _Loader(yaml.SafeLoader):
    """YAML 1.1 reads `80:80` as a base-60 number; compose reads it as text. Keep every integer as text."""


_Loader.yaml_implicit_resolvers = {
    key: [(tag, rx) for tag, rx in resolvers if tag != "tag:yaml.org,2002:int"]
    for key, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
}


def load_yaml(text: str) -> dict:
    data = yaml.load(text, Loader=_Loader)  # noqa: S506 (a safe loader subclass)
    return data if isinstance(data, dict) else {}


@dataclass
class Finding:
    stack: str
    service: str
    rule: str
    value: str
    message: str

    def __str__(self) -> str:
        where = f"{self.stack}/{self.service}" if self.service else self.stack
        return f"{where}: [{self.rule}] {self.message}"


@dataclass
class Policy:
    exceptions: list[dict] = field(default_factory=list)
    allowed_caps: list[str] = field(default_factory=list)
    used: set[int] = field(default_factory=set)

    def allows(self, stack: str, service: str, rule: str, value: str) -> bool:
        for i, e in enumerate(self.exceptions):
            if e.get("rule") != rule or e.get("stack") not in (stack, "*"):
                continue
            if e.get("service") not in (None, service):
                continue
            if e.get("value") not in (None, value):
                continue
            self.used.add(i)
            return True
        return False


def load_policy(path: Path) -> Policy:
    data = json.loads(path.read_text(encoding="utf-8"))
    return Policy(exceptions=data.get("exceptions", []), allowed_caps=data.get("allowed_caps", []))


def check_policy_file(policy: Policy) -> list[str]:
    errors = []
    for i, e in enumerate(policy.exceptions):
        for key in ("stack", "rule", "reason"):
            if not isinstance(e.get(key), str) or not e[key].strip():
                errors.append(f"policy.json exception #{i}: `{key}` must be a non-empty text")
    return errors


def _ports(spec) -> tuple[str, str, str]:
    """(host ip or "", published port or range, protocol) of one `ports` entry, short or long syntax."""
    if isinstance(spec, dict):
        return str(spec.get("host_ip", "")), str(spec.get("published", spec.get("target", ""))), spec.get("protocol", "tcp")
    text, _, proto = str(spec).partition("/")
    parts = text.split(":")
    if len(parts) >= 3:
        return ":".join(parts[:-2]), parts[-2], proto or "tcp"
    if len(parts) == 2:
        return "", parts[0], proto or "tcp"
    return "", parts[0], proto or "tcp"


def _mount_source(spec) -> str | None:
    """The host path or volume name of one `volumes` entry, or None for a tmpfs-like entry without a source."""
    if isinstance(spec, dict):
        return spec.get("source")
    return str(spec).split(":")[0] or None


def _image_floating(image: str) -> bool:
    name = image.split("@")[0]
    if "@sha256:" in image:
        return False
    tail = name.rsplit("/", 1)[-1]
    if ":" not in tail:
        return True
    return tail.split(":", 1)[1] in {"latest", "alpine", "stable", "main", "master", "slim"}


def _service_findings(stack: str, name: str, svc: dict) -> list[Finding]:
    out: list[Finding] = []

    def add(rule: str, value: str, message: str) -> None:
        out.append(Finding(stack, name, rule, value, message))

    if svc.get("privileged") in (True, "true"):
        add("privileged", "true", "runs privileged")
    for key in HOST_NAMESPACES:
        if str(svc.get(key, "")).startswith("host"):
            add("host-namespace", f"{key}: host", f"`{key}: host` shares the host's namespace")
    for cap in svc.get("cap_add", []) or []:
        add("cap_add", str(cap), f"adds the capability {cap}")
    for dev in svc.get("devices", []) or []:
        add("devices", str(dev), f"passes the device {dev} into the container")
    for spec in svc.get("volumes", []) or []:
        src = _mount_source(spec)
        if not src:
            continue
        if src.startswith("/") or src.startswith("~"):
            add("mount", src, f"mounts the host path {src}")
        elif src.startswith(".."):
            add("mount", src, f"mounts {src}, outside the stack folder")
    for spec in svc.get("ports", []) or []:
        ip, published, proto = _ports(spec)
        if ip in LOOPBACK:
            continue
        add("port", f"{published}/{proto}", f"publishes {published}/{proto} on all interfaces")
    image = svc.get("image")
    if isinstance(image, str) and "${" not in image and _image_floating(image):
        add("image", image, f"image {image} has no pinned tag")
    if not image and "build" not in svc:
        add("image", "", "has neither `image` nor `build`")
    if not svc.get("restart"):
        add("restart", "", "has no `restart` policy")
    if not any(str(o).startswith("no-new-privileges") and "false" not in str(o) for o in svc.get("security_opt", []) or []):
        add("no-new-privileges", "", "does not set `security_opt: [no-new-privileges:true]`")
    limit = svc.get("mem_limit") or ((svc.get("deploy") or {}).get("resources") or {}).get("limits", {}).get("memory")
    if not limit:
        add("mem_limit", "", "has no `mem_limit`")
    return out


def lint_compose(stack: str, compose: dict, policy: Policy) -> list[Finding]:
    findings = []
    for name, svc in (compose.get("services") or {}).items():
        for f in _service_findings(stack, name, svc or {}):
            if f.rule == "cap_add" and f.value in policy.allowed_caps:
                continue
            if not policy.allows(stack, name, f.rule, f.value):
                findings.append(f)
    return findings


def env_files(compose: dict) -> list[str]:
    names = []
    for svc in (compose.get("services") or {}).values():
        ef = (svc or {}).get("env_file")
        names += [ef] if isinstance(ef, str) else [e if isinstance(e, str) else e.get("path", "") for e in ef or []]
    return [n for n in names if n]


def check_manifest(root: Path, manifest: dict) -> list[str]:
    """Structure: names, folders, targets, `.env` files that must stay out of git, `.env.example` for every `env_file`."""
    errors: list[str] = []
    targets: set[str] = set()
    for name, entry in manifest.get("stacks", {}).items():
        if not NAME.match(name):
            errors.append(f"{name}: the name must be lowercase letters, digits and -")
        src = root / entry.get("source", "<missing>")
        compose = src / "compose.yaml"
        if not compose.is_file():
            errors.append(f"{name}: {compose.relative_to(root) if src.exists() else entry.get('source')} not found")
            continue
        target = entry.get("target", "")
        if not re.fullmatch(r"/opt/[a-z0-9._/-]+", target) or ".." in target:
            errors.append(f"{name}: target {target!r} must be an absolute path under /opt")
        if target in targets:
            errors.append(f"{name}: target {target} is used by another stack")
        targets.add(target)
        for env in env_files(load_yaml(compose.read_text(encoding="utf-8"))):
            if not (src / f"{env}.example").is_file():
                errors.append(f"{name}: `{env}` is read by the compose file but {env}.example is missing")
    return errors


def tracked_secrets(root: Path, manifest: dict) -> list[str]:
    """Any tracked `.env`-like file (other than `*.example`) in a stack folder."""
    try:
        out = subprocess.run(["git", "ls-files"], cwd=root, capture_output=True, text=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError):
        return []
    folders = [e["source"].rstrip("/") + "/" for e in manifest.get("stacks", {}).values()]
    bad = []
    for path in out.splitlines():
        base = path.rsplit("/", 1)[-1]
        if (base == ".env" or base.startswith(".env.")) and not base.endswith(".example") and any(path.startswith(f) for f in folders):
            bad.append(f"{path}: a secrets file must not be tracked by git")
    return bad


def tracked_files(root: Path, entry: dict) -> list[str]:
    """Files of a stack that are copied to the server (`include` globs, default every file in the folder)."""
    src = entry["source"].rstrip("/")
    out = subprocess.run(["git", "ls-files", src], cwd=root, capture_output=True, text=True, check=True).stdout
    rels = [p[len(src) + 1 :] for p in out.splitlines()]
    include = entry.get("include")
    # `*` must not cross a folder: `*.py` is the files here, not `tests/test_x.py`
    return [r for r in rels if include is None or any(r.count("/") == g.count("/") and fnmatch.fnmatchcase(r, g) for g in include)]


def lint_all(root: Path = ROOT) -> list[str]:
    manifest = json.loads((root / "stacks" / "manifest.json").read_text(encoding="utf-8"))
    policy = load_policy(root / "stacks" / "policy.json")
    problems = check_policy_file(policy) + check_manifest(root, manifest) + tracked_secrets(root, manifest)
    for name, entry in manifest.get("stacks", {}).items():
        compose = root / entry["source"] / "compose.yaml"
        if compose.is_file():
            problems += [str(f) for f in lint_compose(name, load_yaml(compose.read_text(encoding="utf-8")), policy)]
    for i, e in enumerate(policy.exceptions):
        if i not in policy.used:
            problems.append(f"policy.json exception #{i} ({e.get('stack')}/{e.get('rule')}/{e.get('value')}) matches nothing: delete it")
    return problems


def main() -> int:
    problems = lint_all()
    for p in problems:
        print(p)
    print(f"{len(problems)} problem(s)" if problems else "stacks: ok")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
