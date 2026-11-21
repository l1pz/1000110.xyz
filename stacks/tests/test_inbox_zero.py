import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import lint  # noqa: E402

COMPOSE = Path(__file__).resolve().parent.parent / "inbox-zero" / "compose.yaml"


@pytest.fixture
def inbox_zero():
    return lint.load_yaml(COMPOSE.read_text(encoding="utf-8"))


def test_only_web_joins_proxy_network(inbox_zero):
    services = inbox_zero["services"]
    for name, svc in services.items():
        nets = svc.get("networks", [])
        if name == "web":
            assert "proxy" in nets
            assert "internal" in nets
        else:
            assert "proxy" not in nets
            assert "internal" in nets


def test_no_service_publishes_ports(inbox_zero):
    for svc in inbox_zero["services"].values():
        assert not svc.get("ports")


def test_web_has_healthcheck_and_traefik_labels(inbox_zero):
    web = inbox_zero["services"]["web"]
    assert web.get("healthcheck")
    assert web["environment"]["HOSTNAME"] == "0.0.0.0"
    labels = web.get("labels", [])
    assert any("Host(`mail.1000110.xyz`)" in label for label in labels)
    assert "traefik.docker.network=proxy" in labels


def test_internal_services_have_no_traefik_labels(inbox_zero):
    for name in ("db", "redis", "serverless-redis-http", "cron"):
        svc = inbox_zero["services"][name]
        assert not svc.get("labels")
        assert not any("traefik" in str(k) for k in svc.get("labels", []))


def test_no_env_file_is_used(inbox_zero):
    assert lint.env_files(inbox_zero) == []
