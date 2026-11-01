"""Ruminant service: a thread runs the endless self-feeding loop and broadcasts it over SSE. Visitors never send
anything to the model."""

import asyncio
import os
import threading
import time
from collections.abc import Iterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import JSONResponse, StreamingResponse

from hub import HEARTBEAT, Hub, sse
from ruminant import BACKLOG_CHARS, SAVE_EVERY_SECS, Mind, Model, cut_to_sentence, load_state, save_state

MODEL_PATH = os.environ.get("RUMINANT_MODEL", "")
STATE_PATH = os.environ.get("RUMINANT_STATE", "/data/state.json")
HEARTBEAT_SECS = float(os.environ.get("RUMINANT_HEARTBEAT", "15"))

hub = Hub(backlog_chars=BACKLOG_CHARS, max_listeners=int(os.environ.get("RUMINANT_MAX_LISTENERS", "50")))
status = {"chunks": 0, "loops": 0, "model": "up" if MODEL_PATH else "fake"}


class FakeModel(Model):
    """Used when no model is configured (local development): babbles, then loops, so the breaker has work."""

    def __init__(self) -> None:
        self.n = 0

    def complete(self, prompt: str, temperature: float, n_predict: int) -> Iterator[str]:
        self.n += 1
        words = "I keep thinking that a kitchen is a quiet place. " if self.n % 3 else f"Some days are just days, number {self.n}. "
        for w in (words * 4).split(" "):
            time.sleep(0.1)
            yield w + " "

    def count_tokens(self, text: str) -> int:
        return len(text) // 4


def run(loop: asyncio.AbstractEventLoop, stop: threading.Event) -> None:
    """The mind thread. Starts llama-server, restores the saved text, then cycles until told to stop."""

    def publish(kind: str, data: object) -> None:
        loop.call_soon_threadsafe(hub.publish, kind, data)

    proc = None
    if MODEL_PATH:
        import llama

        model: Model = llama.LlamaModel()
        proc = llama.start_server(MODEL_PATH)
        if not llama.wait_ready(proc):
            print("llama-server did not become ready", flush=True)
            return
    else:
        model = FakeModel()

    mind = Mind(model=model, publish=publish, log=lambda s: print(s, flush=True))
    saved = load_state(STATE_PATH)
    if saved:
        mind.restore(saved)
        if mind.text:  # late joiners after a restart should not land on an empty card
            publish("text", cut_to_sentence(mind.text, BACKLOG_CHARS))
    mind.start()
    publish("counters", mind.counters())

    last_save = time.monotonic()
    while not stop.is_set():
        try:
            mind.step()
        except Exception as exc:  # llama-server hiccup: wait, then try again
            print(f"step failed: {exc!r}", flush=True)
            if proc is not None and proc.poll() is not None:
                print("llama-server exited; stopping so the container restarts", flush=True)
                break
            time.sleep(5)
        status.update(chunks=mind.chunks, loops=mind.loops)
        if time.monotonic() - last_save >= SAVE_EVERY_SECS:
            _save(mind)
            last_save = time.monotonic()
    _save(mind)
    if proc is not None:
        proc.terminate()
    if not stop.is_set():
        os._exit(1)  # let Docker restart the container


def _save(mind: Mind) -> None:
    try:
        save_state(STATE_PATH, mind)
    except OSError as exc:
        print(f"could not save state: {exc!r}", flush=True)


@asynccontextmanager
async def lifespan(_: FastAPI):
    stop = threading.Event()
    threading.Thread(target=run, args=(asyncio.get_running_loop(), stop), daemon=True).start()
    yield
    stop.set()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/api/ruminant/health")
def health() -> dict:
    return {"ok": True, "listeners": hub.listeners, **status}


@app.get("/api/ruminant/stream")
async def stream():
    sub = hub.subscribe()
    if sub is None:
        return JSONResponse({"error": "too many listeners"}, status_code=503, headers={"Retry-After": "30"})
    first, listener = sub

    async def events():
        try:
            for event in first:
                yield sse(event)
            while True:
                try:
                    yield sse(await asyncio.wait_for(listener.get(), HEARTBEAT_SECS))
                except asyncio.TimeoutError:
                    yield HEARTBEAT
        finally:
            hub.unsubscribe(listener)

    headers = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    return StreamingResponse(events(), media_type="text/event-stream", headers=headers)
