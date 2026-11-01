"""The monitors.json to Kuma mapping, without a Kuma: `uptime_kuma_api` is replaced by a stub."""

import json
import sys
import types
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent.parent


class _Type:
    HTTP, GAMEDIG, JSON_QUERY = "http", "gamedig", "json-query"


stub = types.ModuleType("uptime_kuma_api")
stub.MonitorType = _Type
stub.NotificationType = types.SimpleNamespace(SMTP="smtp")
stub.UptimeKumaApi = object
sys.modules["uptime_kuma_api"] = stub
sys.path.insert(0, str(HERE))
import provision  # noqa: E402

CONFIG = {"interval": 60, "retries": 2}


def test_an_http_monitor_uses_the_defaults():
    got = provision.monitor_kwargs({"name": "site", "url": "https://x/", "group": "g"}, CONFIG)
    assert got == {"type": "http", "name": "site", "url": "https://x/", "interval": 60, "retryInterval": 60, "maxretries": 2}


def test_extra_overrides_are_passed_on():
    m = {"name": "site", "url": "https://x/", "group": "g", "extra": {"maxredirects": 0}}
    assert provision.monitor_kwargs(m, CONFIG)["maxredirects"] == 0


def test_a_game_monitor_asks_the_game_server():
    m = {"name": "mc", "type": "game", "game": "minecraft", "host": "crafty", "port": 25565, "group": "g"}
    got = provision.monitor_kwargs(m, CONFIG)
    assert (got["type"], got["game"], got["hostname"], got["port"]) == ("gamedig", "minecraft", "crafty", 25565)


def test_a_json_query_monitor_has_its_own_interval_and_retries():
    m = {"name": "deploys", "type": "json-query", "url": "https://x/runs", "query": "a.b", "expected": "success", "interval": 300, "retries": 1, "group": "ci"}
    got = provision.monitor_kwargs(m, CONFIG)
    assert got == {
        "type": "json-query",
        "name": "deploys",
        "url": "https://x/runs",
        "jsonPath": "a.b",
        "expectedValue": "success",
        "interval": 300,
        "retryInterval": 300,
        "maxretries": 1,
    }


def test_an_unknown_type_is_an_error():
    with pytest.raises(ValueError):
        provision.monitor_kwargs({"name": "x", "type": "ping", "group": "g"}, CONFIG)


def test_every_monitor_in_monitors_json_maps_and_has_a_group():
    config = json.loads((HERE / "monitors.json").read_text(encoding="utf-8"))
    names = [m["name"] for m in config["monitors"]]
    assert len(names) == len(set(names))
    for m in config["monitors"]:
        assert m["group"]
        provision.monitor_kwargs(m, config)


def test_the_deploys_monitor_watches_github_actions_for_main():
    config = json.loads((HERE / "monitors.json").read_text(encoding="utf-8"))
    m = next(m for m in config["monitors"] if m["name"] == "deploys")
    assert m["url"].startswith("https://api.github.com/repos/l1pz/1000110.xyz/actions/runs?")
    assert "branch=main" in m["url"] and "status=completed" in m["url"]
    assert m["expected"] == "success" and m["interval"] >= 300  # 12 requests an hour: under GitHub's 60 for anonymous use


class _Timeout(Exception):
    pass


_Timeout.__name__ = "TimeoutError"  # socketio raises its own TimeoutError; the script matches it by name


class _FakeApi:
    def __init__(self, failures, error=_Timeout):
        self.failures, self.error, self.logins, self.disconnects = failures, error, 0, 0

    def login(self, user, password):
        self.logins += 1
        if self.logins <= self.failures:
            raise self.error("no answer")

    def disconnect(self):
        self.disconnects += 1


def _factory(failures, error=_Timeout):
    made = []

    def make(url, timeout):
        made.append(_FakeApi(failures if not made else 0, error))
        return made[-1]

    return make, made


def test_a_login_timeout_is_retried_with_a_fresh_connection():
    make, made = _factory(failures=1)
    api = provision.connect(make, "http://kuma", "u", "p")
    assert len(made) == 2 and api is made[1] and made[0].disconnects == 1


def test_a_login_that_always_times_out_gives_up_after_three_tries():
    class Always(_FakeApi):
        def login(self, user, password):
            raise _Timeout("no answer")

    made = []

    def make(url, timeout):
        made.append(Always(0))
        return made[-1]

    with pytest.raises(_Timeout):
        provision.connect(make, "http://kuma", "u", "p")
    assert len(made) == 3


def test_a_wrong_password_is_not_retried():
    make, made = _factory(failures=5, error=ValueError)
    with pytest.raises(ValueError):
        provision.connect(make, "http://kuma", "u", "bad")
    assert len(made) == 1
