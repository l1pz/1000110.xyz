from pathlib import Path

import pytest

from app.models import Result
from app.sources.libgen import filename_from_disposition, find_match, parse_ads_key, parse_search

FIXTURES = Path(__file__).parent / "fixtures"


def fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8", errors="replace")


def test_search_keeps_only_hungarian_rows():
    results = parse_search(fixture("libgen_search.html"))

    assert results
    assert all(result.language == "hu" for result in results)
    assert all(len(result.md5) == 32 for result in results)
    assert all(result.title for result in results)


def test_search_reads_the_columns():
    results = parse_search(fixture("libgen_search.html"))
    epub = next(result for result in results if result.format == "EPUB")

    assert epub.source == "libgen"
    assert epub.author
    assert epub.size > 0
    assert epub.year is None or 1500 < epub.year < 2100
    assert epub.extension == "epub"


def test_search_of_a_page_without_the_table():
    assert parse_search("<html><body>nincs táblázat</body></html>") == []


def test_ads_page_yields_the_session_key():
    key = parse_ads_key(fixture("libgen_ads.html"))

    assert key
    assert key.isalnum()


def test_ads_page_without_a_key():
    assert parse_ads_key("<html>nincs</html>") == ""


def test_content_disposition_variants():
    assert filename_from_disposition('attachment; filename="Egri csillagok.epub"') == "Egri csillagok.epub"
    assert filename_from_disposition("attachment") == ""
    assert filename_from_disposition("attachment; filename*=UTF-8''Egri%20csillagok.epub") == "Egri csillagok.epub"


def test_find_match_prefers_the_exact_title():
    results = [
        Result(title="Egri csillagok háborúja", author="Hernádi Gyula", format="EPUB"),
        Result(title="Egri csillagok", author="Gárdonyi Géza", format="EPUB"),
        Result(title="A Pál utcai fiúk", author="Molnár Ferenc", format="EPUB"),
    ]

    match = find_match(results, "Egri csillagok", "Gárdonyi Géza")

    assert match is not None
    assert match.title == "Egri csillagok"


def test_find_match_rejects_a_different_book():
    results = [Result(title="A Pál utcai fiúk", author="Molnár Ferenc")]

    assert find_match(results, "Egri csillagok", "Gárdonyi Géza") is None