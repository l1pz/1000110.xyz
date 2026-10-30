"""Scores Beatport search results against a parsed SoundCloud track. A port of the browser logic it replaced (see
`parse.py`). A wrong silent match is the worst failure, so `match` is strict and everything unsure is `maybe` or `none`."""

import re
from dataclasses import dataclass

from parse import SPECIAL_LETTERS, Parsed, normalize

KEEP = 5
PLAIN_MIX = re.compile(r"(?:original(?: mix)?|extended(?: mix)?|radio edit|radio mix)?")


@dataclass
class Scored:
    candidate: dict  # {id, title, mix, artists, durationSec}
    score: float
    parts: dict  # {title, artist, mix, duration}


@dataclass
class MatchResult:
    verdict: str  # "match" | "maybe" | "none"
    ranked: list[Scored]  # best first, at most KEEP


def similarity(a: str, b: str) -> float:
    """Dice coefficient of character pairs: 1 for equal text, 0 for nothing in common."""
    if a == b:
        return 1.0
    if len(a) < 2 or len(b) < 2:
        return 0.0
    pairs: dict[str, int] = {}
    for i in range(len(a) - 1):
        pairs[a[i : i + 2]] = pairs.get(a[i : i + 2], 0) + 1
    shared = 0
    for i in range(len(b) - 1):
        pair = b[i : i + 2]
        if pairs.get(pair, 0) > 0:
            pairs[pair] -= 1
            shared += 1
    return 2 * shared / (len(a) + len(b) - 2)


def spellings(text: str) -> list[str]:
    """`AREA ØNE` is `AREA NE` on Beatport: names are compared with `ø` as "o" and again with such letters dropped."""
    return [normalize(text), normalize(SPECIAL_LETTERS.sub("", text))]


def artist_score(parsed: list[str], candidate: list[str]) -> float:
    """Share of the track's artists found in the candidate's artist list (as whole words)."""
    if not parsed:
        return 0.0
    haystacks = [f" {h} " for h in spellings(" ".join(candidate))]
    found = [
        name
        for name in parsed
        if any(needle != "" and f" {needle} " in haystacks[i] for i, needle in enumerate(spellings(name)))
    ]
    return len(found) / len(parsed)


def mix_score(parsed: str, candidate: str) -> float:
    """A title with no mix is usually the original, so it fits "Original Mix" best and "Extended Mix" nearly as well."""
    want, have = normalize(parsed), normalize(candidate)
    if want == "":
        if have in ("", "original mix", "original"):
            return 1.0
        return 0.8 if PLAIN_MIX.fullmatch(have) else 0.3
    if PLAIN_MIX.fullmatch(want) and PLAIN_MIX.fullmatch(have):
        return 1.0
    return similarity(want, have)


def duration_score(a: float | None, b: float | None) -> float:
    if a is None or b is None:
        return 0.5
    diff = abs(a - b)
    if diff <= 2:
        return 1.0
    if diff <= 5:
        return 0.6
    return 0.2 if diff <= 15 else 0.0


def score_candidate(parsed: Parsed, candidate: dict) -> Scored:
    parts = {
        "title": similarity(normalize(parsed.title), normalize(candidate.get("title", ""))),
        "artist": artist_score(parsed.artists, candidate.get("artists", [])),
        "mix": mix_score(parsed.mix, candidate.get("mix", "")),
        "duration": duration_score(parsed.duration_sec, candidate.get("durationSec")),
    }
    # a guessed artist is the uploader's name, which is often a label or a fan channel
    w = (
        {"title": 0.6, "artist": 0.1, "mix": 0.2, "duration": 0.1}
        if parsed.artist_guessed
        else {"title": 0.45, "artist": 0.25, "mix": 0.2, "duration": 0.1}
    )
    return Scored(candidate, sum(parts[k] * w[k] for k in ("title", "artist", "mix", "duration")), parts)


def match_track(parsed: Parsed, candidates: list[dict]) -> MatchResult:
    """Ranks Beatport results for one SoundCloud track and judges the best one."""
    ranked = sorted((score_candidate(parsed, c) for c in candidates), key=lambda s: -s.score)[:KEEP]
    if not ranked:
        return MatchResult("none", ranked)
    best = ranked[0]
    title, artist, mix = best.parts["title"], best.parts["artist"], best.parts["mix"]
    if best.score >= 0.85 and title >= 0.9 and mix >= 0.8 and (parsed.artist_guessed or artist >= 0.5):
        return MatchResult("match", ranked)
    # a title shared with an unrelated track is no suggestion: with no artist in common (and a real artist to
    # compare), the length has to agree as well
    unrelated = not parsed.artist_guessed and artist == 0 and best.parts["duration"] < 0.6
    return MatchResult("maybe" if best.score >= 0.55 and title >= 0.6 and not unrelated else "none", ranked)
