from pathlib import Path

import httpx
import pytest

from app.sources.annas import (
    is_challenge,
    parse_details,
    parse_download_slots,
    parse_search,
    parse_slow_page,
)

FIXTURES = Path(__file__).parent / "fixtures"


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8", errors="replace")


def test_search_returns_the_hungarian_rows():
    results = parse_search(fixture("annas_search_hu.html"))

    assert len(results) == 50
    assert all(len(result.md5) == 32 for result in results)
    assert all(result.title for result in results)
    assert all(result.language == "hu" for result in results)
    assert {"EPUB", "PDF"} & {result.format for result in results}


def test_search_reads_title_author_and_size():
    results = parse_search(fixture("annas_search_hu.html"))
    kaddish = next(result for result in results if result.md5 == "ec7fe70bd4f63e439eb1bc7335398df1")

    assert kaddish.title.startswith("KADDIS a MEG NEM SZULETETT GYERMEKERT")
    assert kaddish.author == "Imre Kertész"
    assert kaddish.format == "EPUB"
    assert kaddish.year == 2002
    assert 150_000 < kaddish.size < 250_000
    assert kaddish.original_path.endswith(".epub")
    assert kaddish.extension == "epub"


def test_search_ignores_a_page_without_results():
    assert parse_search("<html><body><p>nincs találat</p></body></html>") == []


def test_details_reads_the_metadata_block():
    details = parse_details(fixture("annas_md5.html"))

    assert details.title.startswith("KADDIS a MEG NEM SZULETETT GYERMEKERT")
    assert details.author == "Imre Kertész"
    assert details.publisher.startswith("Magvető")
    assert details.format == "EPUB"
    assert details.year == 2002
    assert details.filename.endswith(".epub")


def test_download_slots_are_deduplicated():
    slots = parse_download_slots(fixture("annas_md5.html"), "ec7fe70bd4f63e439eb1bc7335398df1")

    assert slots[0] == "/slow_download/ec7fe70bd4f63e439eb1bc7335398df1/0/0"
    assert len(slots) == 16


def test_slow_page_finds_the_partner_link():
    seconds, partner = parse_slow_page(fixture("annas_slow_ready.html"))

    assert seconds == 0
    assert partner.startswith("https://")
    assert "/md5/" not in partner


def test_slow_page_reports_the_countdown():
    html = '<div class="mb-4 font-bold">Please wait <span class="js-partner-countdown">41</span> seconds</div>'

    assert parse_slow_page(html) == (41, "")


def test_slow_page_without_either_state():
    assert parse_slow_page("<html><body>semmi</body></html>") == (0, "")


def test_challenge_detection():
    challenge = httpx.Response(403, text=fixture("annas_challenge.html"))

    assert is_challenge(challenge)
    assert not is_challenge(httpx.Response(403, text="<html>nope</html>"))
    assert not is_challenge(httpx.Response(404, text=fixture("annas_challenge.html")))