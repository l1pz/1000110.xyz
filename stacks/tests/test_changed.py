import json
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))
import changed  # noqa: E402
import lint  # noqa: E402

MANIFEST = {
    "stacks": {
        "web": {"source": "stacks/web", "target": "/opt/stacks/web", "auto": True},
        "proxy": {"source": "stacks/proxy", "target": "/opt/stacks/proxy", "auto": True, "approval": True},
        "api": {"source": "api", "target": "/opt/stacks/api", "auto": True, "include": ["compose.yaml", "*.py"]},
        "later": {"source": "stacks/later", "target": "/opt/stacks/later"},
    }
}


def names(picked):
    return [p["stack"] for p in picked]


def test_a_changed_file_in_an_auto_stack_picks_it():
    assert names(changed.pick(MANIFEST, ["stacks/web/compose.yaml"])) == ["web"]


def test_a_stack_without_auto_is_not_picked():
    assert changed.pick(MANIFEST, ["stacks/later/compose.yaml"]) == []


def test_unrelated_changes_pick_nothing():
    assert changed.pick(MANIFEST, ["src/home.ts", "TASKS.md", "stacks/manifest.json", "stacks/lint.py"]) == []


def test_a_folder_name_prefix_is_not_a_match():
    assert changed.pick(MANIFEST, ["stacks/website/compose.yaml", "api2/app.py"]) == []


def test_only_files_that_are_copied_count():
    assert names(changed.pick(MANIFEST, ["api/tests/test_app.py", "api/README.md", "api/requirements-dev.txt"])) == []
    assert names(changed.pick(MANIFEST, ["api/app.py"])) == ["api"]
    assert names(changed.pick(MANIFEST, ["api/compose.yaml"])) == ["api"]


def test_the_order_is_the_manifests_and_the_approval_flag_is_passed_on():
    picked = changed.pick(MANIFEST, ["api/app.py", "stacks/proxy/compose.yaml", "stacks/web/compose.yaml"])
    assert picked == [
        {"stack": "web", "approval": False},
        {"stack": "proxy", "approval": True},
        {"stack": "api", "approval": False},
    ]


def test_a_forced_stack_is_picked_without_auto_or_changes():
    assert changed.pick(MANIFEST, [], "later") == [{"stack": "later", "approval": False}]
    assert changed.pick(MANIFEST, [], "proxy") == [{"stack": "proxy", "approval": True}]


def test_a_forced_unknown_stack_is_an_error():
    with pytest.raises(SystemExit):
        changed.pick(MANIFEST, [], "nope")


@pytest.mark.parametrize(
    ("entry", "files"),
    [
        ({"source": "x"}, ["compose.yaml", "app.py", "tests/test_a.py", ".env.example"]),
        ({"source": "x", "include": ["compose.yaml", "*.py"]}, ["compose.yaml", "app.py", "tests/test_a.py", "README.md"]),
        ({"source": "x", "include": ["*.py", "README.md", "sub/*.txt"]}, ["a.py", "sub/a.py", "sub/a.txt", "sub/deep/a.txt", "README.md"]),
    ],
)
def test_the_selection_rule_equals_the_deploy_scripts(entry, files, monkeypatch):
    class Done:
        stdout = "".join(f"x/{f}\n" for f in files)

    monkeypatch.setattr(lint.subprocess, "run", lambda *a, **k: Done())
    copied = lint.tracked_files(Path("."), entry)
    assert [f for f in files if changed.deployed(entry, f)] == copied


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=True).stdout.strip()


@pytest.fixture
def repo(tmp_path):
    git(tmp_path, "init", "-q", "-b", "main")
    git(tmp_path, "config", "user.email", "t@example.com")
    git(tmp_path, "config", "user.name", "t")
    (tmp_path / "a.txt").write_text("1")
    git(tmp_path, "add", "-A")
    git(tmp_path, "commit", "-q", "-m", "one")
    return tmp_path


def commit(repo, name):
    (repo / name).parent.mkdir(parents=True, exist_ok=True)
    (repo / name).write_text("x")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", name)
    return git(repo, "rev-parse", "HEAD")


def test_changed_paths_cover_a_push_of_several_commits(repo):
    before = git(repo, "rev-parse", "HEAD")
    commit(repo, "stacks/web/compose.yaml")
    tip = commit(repo, "src/x.ts")
    assert sorted(changed.changed_paths(repo, before, tip)) == ["src/x.ts", "stacks/web/compose.yaml"]


@pytest.mark.parametrize("before", ["", changed.ZEROS, "f" * 40])
def test_a_missing_or_unknown_before_falls_back_to_the_last_commit(repo, before):
    commit(repo, "old.txt")
    tip = commit(repo, "stacks/web/compose.yaml")
    assert changed.changed_paths(repo, before, tip) == ["stacks/web/compose.yaml"]


def test_the_command_prints_github_output_lines(capsys, monkeypatch):
    monkeypatch.setattr(changed, "changed_paths", lambda *a: ["kuma/compose.yaml"])
    assert changed.main(["--before", "a" * 40, "--sha", "b" * 40]) == 0
    lines = capsys.readouterr().out.splitlines()
    manifest = json.loads((HERE / "manifest.json").read_text())
    assert lines[0].startswith("matrix=") and json.loads(lines[0][7:]) == {"include": [{"stack": "uptime-kuma", "approval": False}]}
    assert lines[1] == "any=true"
    assert manifest["stacks"]["uptime-kuma"]["auto"] is True


def test_nothing_changed_prints_an_empty_matrix(capsys, monkeypatch):
    monkeypatch.setattr(changed, "changed_paths", lambda *a: ["src/home.ts"])
    changed.main(["--sha", "b" * 40])
    lines = capsys.readouterr().out.splitlines()
    assert json.loads(lines[0][7:]) == {"include": []} and lines[1] == "any=false"
