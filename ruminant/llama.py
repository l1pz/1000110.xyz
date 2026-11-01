"""llama-server: starting it and talking to it. Plain `/completion` with no chat template."""

import json
import os
import subprocess
import time
import urllib.request
from collections.abc import Iterator

import ruminant
from ruminant import BANNED, Model

SERVER_BIN = os.environ.get("RUMINANT_LLAMA_BIN", "/opt/llama/llama-server")
PORT = int(os.environ.get("RUMINANT_LLAMA_PORT", "8080"))
CTX_SIZE = 4096
THREADS = int(os.environ.get("RUMINANT_THREADS", "3"))
BASE = f"http://127.0.0.1:{PORT}"


def server_command(model_path: str) -> list[str]:
    # --swa-full is required: without it the prompt cache barely works with Gemma 4
    return [
        SERVER_BIN, "-m", model_path, "--host", "127.0.0.1", "--port", str(PORT),
        "--ctx-size", str(CTX_SIZE), "--parallel", "1", "--cache-reuse", "256", "--swa-full",
        "--threads", str(THREADS), "--no-webui",
    ]  # fmt: skip


def start_server(model_path: str) -> subprocess.Popen:
    env = dict(os.environ, LD_LIBRARY_PATH=os.path.dirname(SERVER_BIN) + "/lib")
    return subprocess.Popen(server_command(model_path), env=env)


def wait_ready(proc: subprocess.Popen, timeout: float = 300) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and proc.poll() is None:
        try:
            with urllib.request.urlopen(f"{BASE}/health", timeout=2) as r:
                if r.status == 200:
                    return True
        except OSError:
            pass
        time.sleep(1)
    return False


class LlamaModel(Model):
    def _post(self, path: str, body: dict, timeout: float):
        req = urllib.request.Request(
            BASE + path, json.dumps(body).encode(), {"Content-Type": "application/json"}
        )
        return urllib.request.urlopen(req, timeout=timeout)

    def complete(self, prompt: str, temperature: float, n_predict: int) -> Iterator[str]:
        body = {
            "prompt": prompt, "n_predict": n_predict, "temperature": temperature, **ruminant.SAMPLING, "stream": True, "cache_prompt": True, "ignore_eos": True,
            "logit_bias": [[t, False] for t in BANNED],
        }  # fmt: skip
        # a trim makes the server re-read everything, which can take tens of seconds on 3 cores
        with self._post("/completion", body, timeout=600) as resp:
            for line in resp:
                line = line.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                obj = json.loads(line[5:])
                if obj.get("content"):
                    yield obj["content"]
                if obj.get("stop"):
                    return

    def count_tokens(self, text: str) -> int:
        with self._post("/tokenize", {"content": text}, timeout=30) as resp:
            return len(json.load(resp)["tokens"])
