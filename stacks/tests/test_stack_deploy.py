"""stack_deploy against a real temporary git repository, with docker faked."""

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE))
import stack_deploy as sd  # noqa: E402

COMPOSE = """services:
  app:
    image: example/app:1.2.3
    restart: unless-stopped
    security_opt: [no-new-privileges:true]
    mem_limit: 64m
    env_file: .env
"""
SHA = "0" * 40


def git(cwd: Path, *args: str) -> str:
    done = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=True)
    return done.stdout.strip()


class FakeDocker(sd.Runner):
    """Real git, fake docker: records every docker call and answers from `answers`."""

    def __init__(self):
        self.calls: list[list[str]] = []
        self.rc = {"config": 0, "up": 0}
        self.ps = [{"Service": "app", "State": "running", "Health": "healthy"}]

    def run(self, cmd, cwd=None, env=None):
        if cmd[0] != "docker":
            return super().run(cmd, cwd, env)
        self.calls.append(cmd)
        verb = next(v for v in ("config", "up", "ps", "logs") if v in cmd)
        out = "\n".join(json.dumps(r) for r in self.ps) if verb == "ps" else ""
        return subprocess.CompletedProcess(cmd, self.rc.get(verb, 0), out, "")

    def verbs(self) -> list[str]:
        return [next(v for v in ("config", "up", "ps", "logs") if v in c) for c in self.calls]


class World:
    def __init__(self, tmp: Path):
        self.tmp = tmp
        self.origin = tmp / "origin.git"
        self.work = tmp / "work"
        self.fs_root = tmp / "server"
        self.conf = tmp / "conf"
        self.conf.mkdir()
        (self.conf / "stacks").write_text("# allowed\ndemo /opt/stacks/demo\n")
        git(tmp, "init", "-q", "--bare", "-b", "main", str(self.origin))
        self.work.mkdir()
        git(self.work, "init", "-q", "-b", "main")
        git(self.work, "config", "user.email", "t@example.com")
        git(self.work, "config", "user.name", "t")
        git(self.work, "remote", "add", "origin", str(self.origin))
        (self.work / "stacks").mkdir()
        shutil.copy(HERE / "lint.py", self.work / "stacks" / "lint.py")
        (self.work / "stacks" / "policy.json").write_text('{"exceptions": []}')
        self.write_manifest()
        (self.work / "demo").mkdir()
        self.write("demo/compose.yaml", COMPOSE)
        self.write("demo/.env.example", "A=\n")
        self.write("demo/app.py", "print(1)\n")
        self.write("demo/tests/test_app.py", "x = 1\n")
        self.cfg = sd.Config(
            conf_dir=self.conf,
            state_dir=tmp / "state",
            repo_url=str(self.origin),
            health_timeout=0,
            health_interval=0,
            fs_root=self.fs_root,
        )
        self.docker = FakeDocker()
        self.target = self.fs_root / "opt/stacks/demo"
        self.target.mkdir(parents=True)

    def write_manifest(self, target="/opt/stacks/demo"):
        manifest = {"stacks": {"demo": {"source": "demo", "target": target, "include": ["compose.yaml", "*.py", ".env.example"]}}}
        (self.work / "stacks" / "manifest.json").write_text(json.dumps(manifest))

    def write(self, rel: str, text: str):
        path = self.work / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def commit(self, branch="main") -> str:
        git(self.work, "add", "-A")
        git(self.work, "commit", "-q", "-m", "c")
        git(self.work, "push", "-q", "-f", "origin", f"HEAD:{branch}")
        return git(self.work, "rev-parse", "HEAD")

    def deploy(self, request: str) -> int:
        return sd.main(request.split(), self.cfg, self.docker)


@pytest.fixture
def world(tmp_path):
    w = World(tmp_path)
    w.sha = w.commit()
    return w


def test_deploys_the_tracked_files_and_starts_the_stack(world):
    (world.target / ".env").write_text("SECRET=1\n")
    (world.target / "data").mkdir()
    (world.target / "data" / "keep.txt").write_text("keep")
    assert world.deploy(f"demo {world.sha}") == 0
    assert (world.target / "compose.yaml").read_text() == COMPOSE
    assert (world.target / "app.py").is_file()
    assert not (world.target / "tests").exists()  # not in `include`
    assert (world.target / ".env").read_text() == "SECRET=1\n"  # never touched
    assert (world.target / "data" / "keep.txt").read_text() == "keep"  # nothing is deleted
    assert world.docker.verbs() == ["config", "up", "ps"]
    up = world.docker.calls[1]
    assert up[-3:] == ["-d", "--build", "--remove-orphans"] or "--remove-orphans" in up


def test_validates_before_it_changes_anything(world):
    world.deploy(f"demo {world.sha}")
    assert world.docker.verbs()[0] == "config"


def test_the_log_records_the_deploy(world):
    world.deploy(f"demo {world.sha}")
    log = (world.cfg.state_dir / "deploy.log").read_text()
    assert f"demo {world.sha}" in log and " ok" in log and "up and healthy" in log


def test_a_replaced_file_is_kept_in_prev(world):
    (world.target / "app.py").write_text("old\n")
    world.deploy(f"demo {world.sha}")
    assert (world.target / ".stack-deploy-prev" / "app.py").read_text() == "old\n"
    assert (world.target / "app.py").read_text() == "print(1)\n"


def test_an_unchanged_stack_copies_nothing(world, capsys):
    world.deploy(f"demo {world.sha}")
    capsys.readouterr()
    world.deploy(f"demo {world.sha}")
    assert "0 file(s) differ" in capsys.readouterr().out


def test_plan_changes_nothing_and_asks_docker_for_a_dry_run(world, capsys):
    assert world.deploy(f"plan demo {world.sha}") == 0
    assert not (world.target / "compose.yaml").exists()
    assert world.docker.verbs() == ["config", "up"]
    assert "--dry-run" in world.docker.calls[1]
    assert "+ compose.yaml" in capsys.readouterr().out


@pytest.mark.parametrize(
    "request_text",
    ["", "demo", f"demo {SHA} extra", f"Demo {SHA}", f"demo {SHA[:39]}", "demo main", f"../x {SHA}", f"demo {SHA}; rm -rf /", f"plan  demo {SHA}"],
)
def test_odd_requests_are_refused(world, request_text):
    assert world.deploy(request_text) == sd.EXIT_REFUSED
    assert world.docker.calls == []


def test_a_stack_outside_the_allowlist_is_refused(world):
    (world.conf / "stacks").write_text("other /opt/stacks/other\n")
    assert world.deploy(f"demo {world.sha}") == sd.EXIT_REFUSED
    assert world.docker.calls == []


def test_no_allowlist_means_nothing_is_allowed(world):
    (world.conf / "stacks").unlink()
    assert world.deploy(f"demo {world.sha}") == sd.EXIT_REFUSED


def test_a_commit_that_is_not_on_main_is_refused(world):
    world.write("demo/app.py", "evil\n")
    evil = world.commit(branch="evil")
    git(world.work, "push", "-q", "-f", "origin", f"{world.sha}:main")  # main stays at the good commit
    assert world.deploy(f"demo {evil}") == sd.EXIT_REFUSED
    assert not (world.target / "app.py").exists()


def test_an_unknown_commit_is_refused(world):
    assert world.deploy(f"demo {'a' * 40}") == sd.EXIT_REFUSED


def test_a_failing_lint_stops_the_deploy(world):
    world.write("demo/compose.yaml", COMPOSE.replace("    mem_limit: 64m\n", "") + "    privileged: true\n")
    sha = world.commit()
    assert world.deploy(f"demo {sha}") == sd.EXIT_INVALID
    assert not (world.target / "compose.yaml").exists()
    assert "up" not in world.docker.verbs()


def test_a_target_that_differs_from_the_servers_is_refused(world):
    world.write_manifest(target="/opt/stacks/elsewhere")
    sha = world.commit()
    assert world.deploy(f"demo {sha}") == sd.EXIT_INVALID
    assert not (world.target / "compose.yaml").exists()


def test_a_compose_config_error_stops_the_deploy(world):
    world.docker.rc["config"] = 1
    assert world.deploy(f"demo {world.sha}") == sd.EXIT_INVALID
    assert not (world.target / "compose.yaml").exists()
    assert "up" not in world.docker.verbs()


def test_a_stack_that_does_not_come_up_healthy_fails(world, capsys):
    world.docker.ps = [{"Service": "app", "State": "running", "Health": "unhealthy"}]
    assert world.deploy(f"demo {world.sha}") == sd.EXIT_FAILED
    assert "logs" in world.docker.verbs()
    assert (world.cfg.state_dir / "deploy.log").read_text().count("refused/failed (4)") == 1


def test_an_exited_service_fails(world):
    world.docker.ps = [{"Service": "app", "State": "exited", "Health": ""}]
    assert world.deploy(f"demo {world.sha}") == sd.EXIT_FAILED


def test_a_failing_up_fails_and_keeps_the_previous_files(world):
    (world.target / "app.py").write_text("old\n")
    world.docker.rc["up"] = 1
    assert world.deploy(f"demo {world.sha}") == sd.EXIT_FAILED
    assert (world.target / ".stack-deploy-prev" / "app.py").read_text() == "old\n"


def test_a_service_without_a_health_check_counts_as_healthy_when_running(world):
    world.docker.ps = [{"Service": "app", "State": "running"}]
    assert world.deploy(f"demo {world.sha}") == 0


def test_a_first_deploy_creates_the_folder(world):
    shutil.rmtree(world.target)
    assert world.deploy(f"demo {world.sha}") == 0
    assert (world.target / "compose.yaml").is_file()
