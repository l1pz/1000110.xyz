"""Splits a SoundCloud title into artists, title and mix. A port of the browser logic it replaced: the jobs run on the
server with the page closed, so this is the one implementation. `tests/fixtures/real_expected.json` pins its output on
30 real tracks."""

import re
import unicodedata
from dataclasses import dataclass

# `\b` and `\s` below behave like JavaScript's (ASCII word characters), which is what the first version was tuned on
DASH = re.compile(r"^(.+?)\s+[-–—]\s+(.+)$")
GROUP = re.compile(r"[(\[]([^()\[\]]*)[)\]]")
FEAT = re.compile(r"^(?:feat\.?|ft\.?|featuring)\s+(.+)$", re.IGNORECASE)
MIX_WORD = re.compile(
    r"\b(?:mix|remix|edit|dub|version|bootleg|rework|vip|flip|refix|remaster(?:ed)?)\b", re.IGNORECASE | re.ASCII
)
JUNK_WORD = re.compile(
    r"\b(?:free\s*(?:download|dl)|fd|buy|premiere|out now|exclusive|preview|clip|snippet|forthcoming|download|dl)\b",
    re.IGNORECASE | re.ASCII,
)
# `Premiere | `, `PREMIERE : `, `FREE DOWNLOAD | ` in front of the artist
LEADING_JUNK = re.compile(r"^\s*(?:premiere|exclusive|out now|free\s*(?:download|dl))\s*[:|\-–—]\s*", re.IGNORECASE)
TRAILING_JUNK = re.compile(r"\s*[-|:]?\s*free\s*(?:download|dl)\s*$", re.IGNORECASE)
# `Song OUT NOW!`, `Song - OUT NOW`
OUT_NOW_TAIL = re.compile(r"[\s!|\-–—:]*\bout now\b[!\s]*$", re.IGNORECASE | re.ASCII)
# a catalogue number at the end of the title (`System Failure RCR010`); it needs a word before it, so a title
# that is only such a word (`ABC123`) is left alone
CATALOG_TAIL = re.compile(r"\s+[A-Z]{2,6}\d{2,4}$")
ARTIST_SEPARATOR = re.compile(
    r"\s*(?:,|&|×|\band\b|\bx\b|\bvs\.?|\bfeat\.?|\bft\.?|\bfeaturing|\bwith)\s*", re.IGNORECASE | re.ASCII
)
INLINE_FEAT = re.compile(r" (?:feat\.?|ft\.?|featuring) (.+)$", re.IGNORECASE)
EDGE_PUNCTUATION = re.compile(r"^[\s\-–—|:]+|[\s\-–—|:]+$")

# Letters that do not decompose into a base letter plus an accent, so NFKD leaves them alone
FOLDED = {"ø": "o", "đ": "d", "ł": "l", "æ": "ae", "œ": "oe", "ß": "ss", "þ": "th", "ð": "d", "ı": "i"}
SPECIAL_LETTERS = re.compile("[øđłæœßþðı]", re.IGNORECASE)


def normalize(text: str) -> str:
    """Lowercase, no accents, `ø` as "o", `&` as "and", letters and digits separated by single spaces."""
    text = unicodedata.normalize("NFKD", text).lower()
    text = SPECIAL_LETTERS.sub(lambda m: FOLDED.get(m.group(0), m.group(0)), text)
    out = []
    for char in text:
        category = unicodedata.category(char)
        if category.startswith("M"):
            continue
        if char == "&":
            out.append(" and ")
        elif category[0] in "LN":
            out.append(char)
        else:
            out.append(" ")
    return re.sub(r" +", " ", "".join(out)).strip()


@dataclass
class Parsed:
    artists: list[str]
    title: str
    mix: str  # remix, edit or version name from the title; empty when the title names none
    duration_sec: float | None
    artist_guessed: bool  # no `Artist - Title` split, so the artist is the uploader's name


def split_artists(text: str) -> list[str]:
    return [name for name in (n.strip() for n in ARTIST_SEPARATOR.split(text)) if name]


def parse_track(title: str, uploader: str, duration_sec: float | None) -> Parsed:
    """Junk groups (`[FREE DL]`, `(Premiere)`) and any other square-bracket tag (a label or catalogue number:
    `[Revised Record]`, `[TTC002]`) are dropped, `(feat. X)` joins the artists, and the last group that names a mix
    (`(Foo Remix)`) becomes `mix`. A leading `Premiere |` is dropped too."""
    featured: list[str] = []
    mix = ""
    text = re.sub(r"\s+", " ", title).strip()
    while LEADING_JUNK.search(text):
        text = LEADING_JUNK.sub("", text, count=1)

    def group(match: re.Match) -> str:
        nonlocal mix
        content = match.group(1).strip()
        feat = FEAT.match(content)
        if feat:
            featured.extend(split_artists(feat.group(1)))
            return ""
        if MIX_WORD.search(content):
            mix = content
            return ""
        return "" if JUNK_WORD.search(content) or match.group(0).startswith("[") else match.group(0)

    text = GROUP.sub(group, text)
    text = re.sub(r"\s+", " ", OUT_NOW_TAIL.sub("", TRAILING_JUNK.sub("", text, count=1), count=1)).strip()

    guessed = False
    dash = DASH.match(text)
    if dash:
        artists = split_artists(dash.group(1))
        name = dash.group(2)
    else:
        artists = split_artists(uploader)
        name = text
        guessed = True

    # "Artist - Title - Foo Remix": the mix trails after a second dash
    tail = DASH.match(name)
    if tail and MIX_WORD.search(tail.group(2)) and not mix:
        name = tail.group(1)
        mix = tail.group(2).strip()

    name = CATALOG_TAIL.sub("", name, count=1)

    inline = INLINE_FEAT.search(name)
    if inline:
        featured.extend(split_artists(inline.group(1)))
        name = name[: inline.start()]

    return Parsed(
        artists=[*artists, *featured],
        title=EDGE_PUNCTUATION.sub("", name),
        mix=mix,
        duration_sec=duration_sec,
        artist_guessed=guessed,
    )


def search_query(parsed: Parsed) -> str:
    """The Beatport search text for a track: its artists and title; the mix is left to the scoring."""
    return re.sub(r"\s+", " ", " ".join([*parsed.artists, parsed.title])).strip()


def label(parsed: Parsed) -> str:
    """`Artist, Artist - Title (Mix)`, the way a track is shown in a list."""
    mix = f" ({parsed.mix})" if parsed.mix else ""
    artists = ", ".join(parsed.artists)
    return f"{artists + ' - ' if artists else ''}{parsed.title}{mix}"
