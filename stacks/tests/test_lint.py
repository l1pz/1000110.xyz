import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import lint  # noqa: E402

GOOD = """
services:
  app:
    image: example/app:1.2.3
    restart: unless-stopped
    security_opt: [no-new-privileges:true]
    mem_limit: 64m
    volumes:
      - ./data:/data
      - cache:/cache
    ports:
      - 127.0.0.1:8443:8443
"""


def run(compose: str, exceptions=None, caps=None, stack="demo"):
    policy = lint.Policy(exceptions=exceptions or [], allowed_caps=caps or [])
    return lint.lint_compose(stack, lint.load_yaml(compose), policy), policy


def rules(findings):
    return sorted((f.rule, f.value) for f in findings)


def test_the_real_repo_is_clean():
    assert lint.lint_all() == []


def test_a_good_service_has_no_findings():
    assert run(GOOD)[0] == []


@pytest.mark.parametrize(
    ("snippet", "expected"),
    [
        ("    privileged: true", [("privileged", "true")]),
        ("    network_mode: host", [("host-namespace", "network_mode: host")]),
        ("    pid: host", [("host-namespace", "pid: host")]),
        ("    cap_add: [SYS_ADMIN]", [("cap_add", "SYS_ADMIN")]),
        ("    devices: ['/dev/sda:/dev/sda']", [("devices", "/dev/sda:/dev/sda")]),
        ("    volumes: ['/var/run/docker.sock:/var/run/docker.sock']", [("mount", "/var/run/docker.sock")]),
        ("    volumes: ['/:/host:ro']", [("mount", "/")]),
        ("    volumes: ['../other:/x']", [("mount", "../other")]),
        ("    volumes: [{type: bind, source: /etc, target: /etc}]", [("mount", "/etc")]),
        ("    ports: ['80:80']", [("port", "80/tcp")]),
        ("    ports: ['19132:19132/udp']", [("port", "19132/udp")]),
        ("    ports: ['25500-25600:25500-25600']", [("port", "25500-25600/tcp")]),
        ("    ports: ['0.0.0.0:9000:9000']", [("port", "9000/tcp")]),
    ],
)
def test_dangerous_settings_are_found(snippet, expected):
    compose = GOOD.replace("    volumes:\n      - ./data:/data\n      - cache:/cache\n    ports:\n      - 127.0.0.1:8443:8443\n", snippet + "\n")
    assert rules(run(compose)[0]) == expected


def test_unquoted_ports_are_not_read_as_base_60_numbers():
    # YAML 1.1 turns 80:80 into the number 4880; compose does not
    compose = GOOD.replace("127.0.0.1:8443:8443", "80:80")
    assert rules(run(compose)[0]) == [("port", "80/tcp")]


@pytest.mark.parametrize("image", ["nginx", "nginx:latest", "nginx:alpine", "registry.example.com/x/y:latest"])
def test_floating_images_are_found(image):
    assert rules(run(GOOD.replace("example/app:1.2.3", image))[0]) == [("image", image)]


def test_pinned_and_local_images_pass():
    assert run(GOOD.replace("example/app:1.2.3", "app:local"))[0] == []
    assert run(GOOD.replace("example/app:1.2.3", "x/y@sha256:" + "a" * 64))[0] == []


def test_missing_hardening_is_found():
    compose = "services:\n  app:\n    image: a/b:1\n"
    assert rules(run(compose)[0]) == [("mem_limit", ""), ("no-new-privileges", ""), ("restart", "")]


def test_deploy_resources_count_as_a_memory_limit():
    compose = GOOD.replace("    mem_limit: 64m\n", "    deploy: {resources: {limits: {memory: 64M}}}\n")
    assert run(compose)[0] == []


def test_an_exception_allows_exactly_what_it_names():
    bad = GOOD + "    cap_add: [NET_ADMIN]\n    privileged: true\n"
    exceptions = [{"stack": "demo", "rule": "cap_add", "value": "NET_ADMIN", "reason": "vpn"}]
    findings, policy = run(bad, exceptions)
    assert rules(findings) == [("privileged", "true")]
    assert policy.used == {0}


def test_an_exception_for_one_stack_does_not_cover_another():
    exceptions = [{"stack": "other", "rule": "privileged", "reason": "x"}]
    assert rules(run(GOOD + "    privileged: true\n", exceptions)[0]) == [("privileged", "true")]


def test_a_star_exception_covers_every_stack():
    exceptions = [{"stack": "*", "rule": "image", "value": "nginx:alpine", "reason": "x"}]
    assert run(GOOD.replace("example/app:1.2.3", "nginx:alpine"), exceptions, stack="anything")[0] == []


def test_allowed_capabilities_pass():
    assert run(GOOD + "    cap_add: [CHOWN]\n", caps=["CHOWN"])[0] == []


def test_policy_exceptions_need_a_reason():
    policy = lint.Policy(exceptions=[{"stack": "a", "rule": "mount", "reason": " "}, {"rule": "port", "reason": "x"}])
    assert len(lint.check_policy_file(policy)) == 2


def project(tmp_path: Path, manifest: dict, compose: str = GOOD, exceptions=None):
    (tmp_path / "stacks").mkdir()
    (tmp_path / "stacks" / "manifest.json").write_text(json.dumps(manifest))
    (tmp_path / "stacks" / "policy.json").write_text(json.dumps({"exceptions": exceptions or []}))
    (tmp_path / "demo").mkdir()
    (tmp_path / "demo" / "compose.yaml").write_text(compose)
    return tmp_path


OK_MANIFEST = {"stacks": {"demo": {"source": "demo", "target": "/opt/stacks/demo"}}}


def test_lint_all_passes_on_a_good_project(tmp_path):
    assert lint.lint_all(project(tmp_path, OK_MANIFEST)) == []


def test_a_stale_exception_is_an_error(tmp_path):
    root = project(tmp_path, OK_MANIFEST, exceptions=[{"stack": "demo", "rule": "privileged", "reason": "was needed"}])
    assert any("matches nothing" in p for p in lint.lint_all(root))


@pytest.mark.parametrize("target", ["relative/path", "/etc/stacks", "/opt/../etc", "/opt/Stacks/x"])
def test_bad_targets_are_rejected(tmp_path, target):
    manifest = {"stacks": {"demo": {"source": "demo", "target": target}}}
    assert any("target" in p for p in lint.check_manifest(project(tmp_path, manifest), manifest))


def test_two_stacks_cannot_share_a_target(tmp_path):
    manifest = {"stacks": {"a": {"source": "demo", "target": "/opt/x"}, "b": {"source": "demo", "target": "/opt/x"}}}
    assert any("used by another" in p for p in lint.check_manifest(project(tmp_path, manifest), manifest))


def test_a_bad_name_and_a_missing_folder_are_rejected(tmp_path):
    manifest = {"stacks": {"Bad_Name": {"source": "demo", "target": "/opt/a"}, "gone": {"source": "nope", "target": "/opt/b"}}}
    problems = lint.check_manifest(project(tmp_path, manifest), manifest)
    assert any("lowercase" in p for p in problems)
    assert any("not found" in p for p in problems)


def test_env_file_needs_an_example(tmp_path):
    compose = GOOD + "    env_file: .env\n"
    root = project(tmp_path, OK_MANIFEST, compose)
    assert any(".env.example is missing" in p for p in lint.check_manifest(root, OK_MANIFEST))
    (root / "demo" / ".env.example").write_text("A=\n")
    assert lint.check_manifest(root, OK_MANIFEST) == []


def test_include_globs_pick_the_copied_files(tmp_path, monkeypatch):
    listing = "demo/compose.yaml\ndemo/app.py\ndemo/tests/test_app.py\ndemo/README.md\ndemo/.env.example\n"

    class Done:
        stdout = listing

    monkeypatch.setattr(lint.subprocess, "run", lambda *a, **k: Done())
    entry = {"source": "demo", "target": "/opt/demo", "include": ["compose.yaml", "*.py", "README.md"]}
    assert lint.tracked_files(tmp_path, entry) == ["compose.yaml", "app.py", "README.md"]
    assert lint.tracked_files(tmp_path, {"source": "demo"}) == [
        "compose.yaml",
        "app.py",
        "tests/test_app.py",
        "README.md",
        ".env.example",
    ]


def test_a_tracked_env_file_is_an_error(tmp_path, monkeypatch):
    class Done:
        stdout = "demo/compose.yaml\ndemo/.env\ndemo/.env.admin\ndemo/.env.example\nother/.env\n"

    monkeypatch.setattr(lint.subprocess, "run", lambda *a, **k: Done())
    bad = lint.tracked_secrets(tmp_path, OK_MANIFEST)
    assert [b.split(":")[0] for b in bad] == ["demo/.env", "demo/.env.admin"]


@pytest.mark.parametrize("flag", ["auto", "approval"])
def test_rollout_flags_must_be_booleans(tmp_path, flag):
    manifest = {"stacks": {"demo": {"source": "demo", "target": "/opt/stacks/demo", flag: "yes"}}}
    root = project(tmp_path, manifest)
    assert any(f"`{flag}` must be true or false" in p for p in lint.check_manifest(root, manifest))
    manifest["stacks"]["demo"][flag] = True
    assert lint.check_manifest(root, manifest) == []
