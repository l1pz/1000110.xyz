"""Ruminant: a small model reads its own words and keeps going. When it starts repeating itself, code notices and
breaks the loop. Everything here is pure (no network, no FastAPI), so the loop can be tested with a fake model.

Every number you may want to tune is a constant at the top."""

import json
import os
import random
import re
import time
import zlib
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from datetime import datetime

# ── identity ─────────────────────────────────────────────────────────────────────────────────────────────────────
RUMINANT = "RUMINANT"  # the name shown on the page; rename it here

# ── the text the model continues ─────────────────────────────────────────────────────────────────────────────────
# Never trimmed, so the prompt cache reuses it and the voice has a home. An empty string means pure chaos.
# Tried: the planned "Notes I write at the kitchen table..." line (drifted into markdown and "analysis" of its own
# text) and a book / chapter framing (the model answered as an assistant: "I do not have the book"). Nothing in this
# one can be analysed or quoted, so there is nothing for the model to turn into an assistant task.
ANCHOR = (
    "Late at night, at the kitchen table, an old man talks to himself about ordinary life, "
    "in plain words, in full paragraphs.\n\n"
)
# Markdown symbols the model may not generate at all (llama.cpp logit_bias: false bans the token).
BANNED = ["*", "**", "***", "`", "```", "#", "##", "###", "---"]

OPENINGS = [
    "The older I get, the more I think",
    "Nobody tells you this, but",
    "My grandmother used to say",
    "The thing about people is",
    "You know what nobody admits?",
    "It's strange how",
    "Most of growing up is",
    "Funny thing about Sundays:",
    "I used to believe",
    "Here's what I've figured out so far:",
    "Nobody ever asks me about",
    "I was thinking about my father, and how",
    "There's a smell I can't place, and",
    "Money is a funny thing because",
    "Every house I lived in had",
    "I never learned how to",
    "People say time heals, but",
    "The neighbours downstairs always",
    "What I miss most is",
    "Some mornings I wake up and",
    "A good friend is someone who",
    "I once spent a whole winter",
    "The hardest thing about being polite is",
    "Nobody warned me that",
    "There was a man at the market who",
]

# ── generation ───────────────────────────────────────────────────────────────────────────────────────────────────
CHUNK_TOKENS = 60  # n_predict per cycle
PACE_CPS = 16  # characters per second shown to visitors; the model waits so the page reads at a human pace (0 = full speed)
TEMPERATURE = 1.0
NUDGE_TEMPERATURE = 1.3  # used for the one chunk after a nudge
# Sent to llama-server with every request. Against looping: a stronger repeat penalty over a longer memory, and the DRY
# sampler, which penalises continuing a phrase the model has already written (the exact failure here).
SAMPLING = {
    "top_p": 0.95,
    "repeat_penalty": 1.1,
    "repeat_last_n": 512,
    "dry_multiplier": 0.8,
    "dry_base": 1.75,
    "dry_allowed_length": 3,
    "dry_penalty_last_n": 2048,
}
# Fresh seeds: every so often, at the end of a paragraph, code starts a new thought with a random opening line, so the
# model has something new to say before it circles back to the same themes. 0 turns it off.
SEED_EVERY_CHUNKS = 10

# ── trimming (one big cut, never a bit each cycle) ───────────────────────────────────────────────────────────────
TRIM_ABOVE_TOKENS = 3000
TRIM_TO_TOKENS = 1000

# ── loop detection ───────────────────────────────────────────────────────────────────────────────────────────────
LOOP_WINDOW_CHARS = 4000  # was 2000: a loop with a period of ~1500 characters (a repeated paragraph block) needs room
LOOP_RATIO = 0.25  # compressed / raw below this means looping (normal prose sits around 0.4)
LOOP_MIN_CHARS = 800  # too little text compresses oddly, so do not judge it
REPEAT_WINDOW_CHARS = 600
REPEAT_COUNT = 3  # the same line, or the same REPEAT_WORDS-word sequence, this many times in the window
REPEAT_WORDS = 8
REPEAT_MIN_LINE = 12  # a line shorter than this does not count as a repeated line
REPEAT_SENTENCE_MIN = 40  # a sentence this long seen REPEAT_COUNT times in the loop window is a loop, however far apart

# ── drift: the model stops writing notes and starts acting like an assistant ─────────────────────────────────────
# Not a loop, so the checks above miss it. Looked for in the newest text only. A hit means a hard reset.
DRIFT_WINDOW_CHARS = 400
DRIFT = re.compile(
    r"\*\*|^\s*(?:#{1,6}\s|[-*]\s|\d+[.)]\s)|^\s*(?:---|\*\*\*)\s*$"
    r"|^\s*[(\[][A-Za-z]"
    r"|\b(?:(?:the|this|that) old man|i must point out|i apologi[sz]e|i cannot|i can't (?:fulfil|help|provide)|i do not have|as an ai|language model"
    r"|let me know|what would you like|paste (?:it|a|the)|provide me|the user|analy[sz]e|this passage|the passage"
    r"|chapter \d|the book)\b",
    re.I | re.M,
)

# ── breaking a loop ──────────────────────────────────────────────────────────────────────────────────────────────
COOLDOWN_CHUNKS = 3  # after any break, do not check for this many chunks
ESCALATE_WITHIN = 5  # still looping within this many chunks of a break: go one step up
CALM_RESET = 10  # this many calm chunks reset the escalation to the nudge

# ── late joiners and persistence ─────────────────────────────────────────────────────────────────────────────────
BACKLOG_CHARS = 6000  # a refresh should look like the same page, so send more than one screenful
SAVE_EVERY_SECS = 60

MARK_FORGETS_BEGINNING = "── it forgets the beginning ──"
BREAK_MARKERS = {
    "nudge": "it caught itself going in circles",
    "jolt": "something interrupted it",
    "forget": "it forgot what it was saying",
}
LEVELS = ["nudge", "jolt", "forget"]

_CONTROL = re.compile(r"[\x00-\x09\x0b-\x1f\x7f-\x9f  ]")
# Special tokens that can slip into the text: <end_of_turn>, <eos>, <|im_end|>, <start_of_turn>user ...
_SPECIAL = re.compile(r"<\|?/?[A-Za-z_][A-Za-z0-9_|]{0,30}\|?>")
_ENDED = re.compile(r"[.!?…]['\")\]]*\s*$")  # the text ends on a finished sentence (a newline counts as ended too)
PARAGRAPH = "\n\n"
_SENTENCE_END = re.compile(r"[.!?…]['\")\]]*\s+|\n+")


def clean(text: str) -> str:
    """Drop control characters (newlines stay). Special tokens are handled by SpecialFilter while streaming."""
    return _CONTROL.sub("", text.replace("\r", ""))


class SpecialFilter:
    """Strips special tokens from a stream of pieces. A piece that ends inside a possible token (`<end_of_`) is held
    back until the next piece shows whether it was one."""

    MAX_HELD = 34

    def __init__(self) -> None:
        self._held = ""

    def feed(self, piece: str) -> str:
        text = self._held + piece
        self._held = ""
        text = _SPECIAL.sub("", text)
        cut = text.rfind("<")
        if cut != -1 and len(text) - cut <= self.MAX_HELD and ">" not in text[cut:]:
            self._held = text[cut:]
            text = text[:cut]
        return clean(text)

    def flush(self) -> str:
        out, self._held = self._held, ""
        return clean(_SPECIAL.sub("", out))


# ── loop detection ───────────────────────────────────────────────────────────────────────────────────────────────
def compress_ratio(text: str) -> float:
    raw = text.encode()
    return len(zlib.compress(raw, 6)) / len(raw) if raw else 1.0


def repeats(text: str) -> bool:
    """The same line, or the same run of words, three or more times in the last few hundred characters."""
    tail = text[-REPEAT_WINDOW_CHARS:]
    lines = [ln.strip() for ln in tail.split("\n") if len(ln.strip()) >= REPEAT_MIN_LINE]
    if any(lines.count(ln) >= REPEAT_COUNT for ln in set(lines)):
        return True
    words = re.findall(r"[\w']+", tail.lower())
    seen: dict[tuple[str, ...], int] = {}
    for i in range(len(words) - REPEAT_WORDS + 1):
        gram = tuple(words[i : i + REPEAT_WORDS])
        seen[gram] = seen.get(gram, 0) + 1
        if seen[gram] >= REPEAT_COUNT:
            return True
    return False


def repeated_sentence(text: str) -> bool:
    """A long sentence that shows up REPEAT_COUNT times in the loop window (a repeated paragraph block)."""
    sentences = [x.strip() for x in _SENTENCE_END.split(text[-LOOP_WINDOW_CHARS:])]
    long = [x for x in sentences if len(x) >= REPEAT_SENTENCE_MIN]
    return any(long.count(x) >= REPEAT_COUNT for x in set(long))


def drifted(text: str) -> bool:
    """Markdown, lists or assistant talk in the newest text."""
    return bool(DRIFT.search(text[-DRIFT_WINDOW_CHARS:]))


def is_looping(text: str) -> bool:
    window = text[-LOOP_WINDOW_CHARS:]
    if len(window) >= LOOP_MIN_CHARS and compress_ratio(window) < LOOP_RATIO:
        return True
    return repeats(text) or repeated_sentence(text)


# ── trimming ─────────────────────────────────────────────────────────────────────────────────────────────────────
def cut_to_sentence(text: str, keep_chars: int) -> str:
    """Keep about the last keep_chars characters, starting at a sentence boundary."""
    if len(text) <= keep_chars:
        return text
    tail = text[-keep_chars:]
    m = _SENTENCE_END.search(tail)
    return tail[m.end() :] if m and m.end() < len(tail) else tail


def last_sentence(text: str) -> str:
    """The last complete sentence (the text after it is usually a half-written one), or the tail when there is none."""
    body = text.rstrip()
    ends = [m.end() for m in _SENTENCE_END.finditer(body)]
    if body[-1:] in (".", "!", "?", "…"):
        ends.append(len(body))  # the text itself ends on a full stop
    if len(ends) >= 2:
        return body[ends[-2] : ends[-1]].strip()
    return (body[: ends[0]] if ends else body[-200:]).strip()


# ── the breaker ──────────────────────────────────────────────────────────────────────────────────────────────────
@dataclass
class Breaker:
    """Decides what to do about a loop. update() is called once per chunk and returns 'nudge', 'jolt', 'forget' or None."""

    level: int = 0  # 0 = calm, 1 = last break was a nudge, 2 = jolt, 3 = forget
    since_break: int | None = None
    cooldown: int = 0
    calm: int = 0
    hot: bool = False  # the next chunk uses NUDGE_TEMPERATURE

    def temperature(self) -> float:
        """Temperature for the next chunk. The nudge is spent once it has been used."""
        t = NUDGE_TEMPERATURE if self.hot else TEMPERATURE
        self.hot = False
        return t

    def force(self, action: str) -> str:
        """A break decided elsewhere (drift): same bookkeeping as a detected loop, no escalation of its own."""
        self.level = LEVELS.index(action) + 1
        self.since_break = 0
        self.cooldown = COOLDOWN_CHUNKS
        self.calm = 0
        self.hot = False
        return action

    def update(self, text: str, looping: Callable[[str], bool] = is_looping) -> str | None:
        if self.since_break is not None:
            self.since_break += 1
        if self.cooldown > 0:
            self.cooldown -= 1
            return None
        if not looping(text):
            self.calm += 1
            if self.calm >= CALM_RESET:
                self.level, self.since_break = 0, None
            return None
        self.calm = 0
        if self.since_break is not None and self.since_break <= ESCALATE_WITHIN:
            self.level = min(self.level + 1, len(LEVELS))
        else:
            self.level = 1
        self.since_break = 0
        self.cooldown = COOLDOWN_CHUNKS
        action = LEVELS[self.level - 1]
        self.hot = action == "nudge"
        return action


# ── the mind ─────────────────────────────────────────────────────────────────────────────────────────────────────
class Model:
    """What the mind needs from a language model. The real one talks to llama-server; tests use a fake."""

    def complete(self, prompt: str, temperature: float, n_predict: int) -> Iterator[str]:
        raise NotImplementedError

    def count_tokens(self, text: str) -> int:
        raise NotImplementedError


def true_line(now: datetime) -> str:
    """A fact from code, dropped into the text when it is interrupted."""
    return f"It's {now:%H:%M}, {now:%A}."


def marker(kind: str, now: datetime) -> str:
    return f"── {now:%H:%M} · {BREAK_MARKERS[kind]} ──"


Publish = Callable[[str, object], None]  # publish("text", "…") / ("marker", "…") / ("counters", {...})


@dataclass
class Mind:
    model: Model
    publish: Publish
    rng: random.Random = field(default_factory=random.Random)
    clock: Callable[[], datetime] = datetime.now  # server local time
    log: Callable[[str], None] = print
    pace_cps: float = PACE_CPS
    sleep: Callable[[float], None] = time.sleep
    since_seed: int = 0
    _due: float = 0.0  # monotonic time at which the text published so far has been "read"
    text: str = ""
    loops: int = 0
    chunks: int = 0
    born: float = field(default_factory=time.time)
    breaker: Breaker = field(default_factory=Breaker)

    def opening(self) -> str:
        return self.rng.choice(OPENINGS)

    def show(self, piece: str) -> None:
        """Publish model text at reading pace: wait until the text before it has had its time."""
        if self.pace_cps > 0:
            now = time.monotonic()
            self._due = max(self._due, now) + len(piece) / self.pace_cps
            wait = self._due - now - 1.0  # a second of slack, so tokens still arrive in small groups
            if wait > 0:
                self.sleep(wait)
        self.publish("text", piece)

    def say(self, piece: str) -> None:
        """Text that code (not the model) puts on the page and into the rolling text."""
        self.text += piece
        self.publish("text", piece)

    def counters(self) -> dict:
        return {"name": RUMINANT, "awake": int(time.time() - self.born), "loops": self.loops}

    def start(self) -> None:
        if not self.text:
            self.say(self.opening() + " ")

    def step(self) -> None:
        """One cycle: generate a chunk, stream it, append it, look for loops, trim."""
        temperature = self.breaker.temperature()
        began = time.monotonic()
        first: float | None = None
        gate = SpecialFilter()
        chunk, pieces = "", 0
        for raw in self.model.complete(ANCHOR + self.text, temperature, CHUNK_TOKENS):
            if first is None:
                first = time.monotonic() - began
            pieces += 1
            piece = gate.feed(raw)
            if piece:
                chunk += piece
                self.show(piece)
        tail = gate.flush()
        if tail:
            chunk += tail
            self.show(tail)
        took = time.monotonic() - began
        self.text += chunk
        self.chunks += 1
        self.log(
            f"chunk {self.chunks} temp={temperature} pieces={pieces} first={first or 0:.1f}s took={took:.1f}s "
            f"ratio={compress_ratio(self.text[-LOOP_WINDOW_CHARS:]):.2f} chars={len(self.text)}"
        )
        self.log("text " + json.dumps(chunk, ensure_ascii=False))

        if drifted(chunk + " "):
            action = self.breaker.force("forget")
            self.log(f"DRIFT {chunk[-120:]!r}")
        else:
            action = self.breaker.update(self.text)
        if action:
            self.loops += 1
            self.log(f"LOOP #{self.loops} -> {action} (level {self.breaker.level})")
            self.interrupt(action)
        else:
            self.trim_if_long()
            self.seed()
        self.publish("counters", self.counters())

    def seed(self) -> None:
        """Every SEED_EVERY_CHUNKS chunks, once a paragraph or sentence has ended, start a new thought."""
        self.since_seed += 1
        if SEED_EVERY_CHUNKS <= 0 or self.since_seed < SEED_EVERY_CHUNKS:
            return
        if not _ENDED.search(self.text):
            return  # wait for the end of a sentence; try again next chunk
        self.since_seed = 0
        self.log("SEED")
        self.say(PARAGRAPH + self.opening() + " ")

    def interrupt(self, action: str) -> None:
        now = self.clock()
        self.publish("marker", marker(action, now))
        self.since_seed = 0
        if action == "jolt":
            self.say("\n\n" + true_line(now) + "\n\n" + self.opening() + " ")
        elif action == "forget":
            self.text = last_sentence(self.text)
            self.say("\n\n" + self.opening() + " ")

    def trim_if_long(self) -> None:
        tokens = self.model.count_tokens(self.text)
        if tokens <= TRIM_ABOVE_TOKENS:
            return
        keep = int(len(self.text) * TRIM_TO_TOKENS / tokens)
        self.text = cut_to_sentence(self.text, keep)
        self.log(f"TRIM {tokens} tokens -> ~{TRIM_TO_TOKENS}, {len(self.text)} chars kept")
        self.publish("marker", MARK_FORGETS_BEGINNING)

    # persistence
    def state(self) -> dict:
        b = self.breaker
        return {
            "text": self.text,
            "loops": self.loops,
            "chunks": self.chunks,
            "born": self.born,
            "breaker": {"level": b.level, "since_break": b.since_break, "cooldown": b.cooldown, "calm": b.calm},
        }

    def restore(self, saved: dict) -> None:
        self.text = str(saved.get("text", ""))
        self.loops = int(saved.get("loops", 0))
        self.chunks = int(saved.get("chunks", 0))
        self.born = float(saved.get("born", self.born))
        b = saved.get("breaker") or {}
        self.breaker = Breaker(
            level=int(b.get("level", 0)),
            since_break=b.get("since_break"),
            cooldown=int(b.get("cooldown", 0)),
            calm=int(b.get("calm", 0)),
        )


def save_state(path: str, mind: Mind) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        json.dump(mind.state(), f, ensure_ascii=False)
    os.replace(tmp, path)


def load_state(path: str) -> dict | None:
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None
