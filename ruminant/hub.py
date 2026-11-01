"""The broadcast core: a ring buffer of recent segments and a set of listeners. No FastAPI, no model, so it is easy to test.

Segments are ("text", "...") or ("marker", "── ... ──"). Counters are not buffered; the latest value is kept and
sent to each new listener."""

import asyncio
import json
import re
from collections import deque

# A data message, not an SSE comment: comments never reach the browser's `onmessage`, and the page's silence watchdog
# has to hear something during a long pause (a trim makes the model re-read everything).
_START = re.compile(r"[.!?…][\"')\]]*\s+|\n+")
_START_WITHIN = 400
HEARTBEAT = 'data: {"t": "hb"}\n\n'


class Hub:
    def __init__(self, backlog_chars: int = 1500, max_listeners: int = 50):
        self.backlog_chars = backlog_chars
        self.max_listeners = max_listeners
        self._segments: deque[list[str]] = deque()
        self._size = 0
        self._cut = False  # the front of the buffer has been trimmed
        self._counters: dict | None = None
        self._queues: set[asyncio.Queue[dict]] = set()

    @property
    def listeners(self) -> int:
        return len(self._queues)

    def backlog(self) -> list[list[str]]:
        """The buffered segments. If the front was cut, it starts at the next sentence, not in the middle of a word."""
        out = [list(s) for s in self._segments]
        if self._cut and out and out[0][0] == "text":
            m = _START.search(out[0][1][:_START_WITHIN])
            if m and m.end() < len(out[0][1]):
                out[0][1] = out[0][1][m.end() :]
        return out

    def publish(self, kind: str, data: object) -> None:
        """Buffer text and markers, remember counters, and hand the event to every listener. Slow ones drop events."""
        if kind == "counters":
            self._counters = data  # type: ignore[assignment]
        else:
            self._buffer(kind, str(data))
        event = {"t": kind, "d": data}
        for q in self._queues:
            if not q.full():
                q.put_nowait(event)

    def _buffer(self, kind: str, text: str) -> None:
        if kind == "text" and self._segments and self._segments[-1][0] == "text":
            self._segments[-1][1] += text
        else:
            self._segments.append([kind, text])
        self._size += len(text)
        while self._size > self.backlog_chars and self._segments:
            self._cut = True
            over = self._size - self.backlog_chars
            head = self._segments[0]
            if head[0] == "text" and len(head[1]) > over:
                head[1] = head[1][over:]
                self._size -= over
            else:
                self._size -= len(head[1])
                self._segments.popleft()

    def subscribe(self) -> tuple[list[dict], "asyncio.Queue[dict]"] | None:
        """Returns (events to send first, queue of new events), or None when the connection cap is reached."""
        if len(self._queues) >= self.max_listeners:
            return None
        q: asyncio.Queue[dict] = asyncio.Queue(maxsize=500)
        self._queues.add(q)
        first = [{"t": "backlog", "d": self.backlog()}]
        if self._counters is not None:
            first.append({"t": "counters", "d": self._counters})
        return first, q

    def unsubscribe(self, q: "asyncio.Queue[dict]") -> None:
        self._queues.discard(q)


def sse(event: dict) -> str:
    """One SSE message. The payload is JSON so newlines inside a token survive the framing."""
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
