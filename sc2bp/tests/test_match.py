import json
from pathlib import Path

from match import match_track, score_candidate, similarity
from parse import parse_track

FIXTURES = Path(__file__).parent / "fixtures"


def track(title, uploader="Some Channel", duration=None):
    return parse_track(title, uploader, duration)


def candidate(**over):
    base = {"id": 1, "title": "Higher State", "mix": "Original Mix", "artists": ["Solomun"], "durationSec": 400}
    return {**base, **over}


def test_similarity():
    assert similarity("abc", "abc") == 1
    assert similarity("abcd", "wxyz") == 0
    assert similarity("a", "b") == 0
    assert similarity("higher state", "higher stat") > 0.85


PARSED = track("Solomun - Higher State", "x", 400)


def test_an_exact_original_scores_one():
    assert abs(score_candidate(PARSED, candidate()).score - 1) < 1e-9


def test_an_extended_mix_is_a_near_fit_for_a_title_without_a_mix():
    assert score_candidate(PARSED, candidate(mix="Extended Mix")).parts["mix"] == 0.8


def test_a_remix_is_penalised_when_the_title_names_none():
    assert score_candidate(PARSED, candidate(mix="Dixon Remix")).parts["mix"] == 0.3


def test_duration_gap_is_graded():
    def at(sec):
        return score_candidate(PARSED, candidate(durationSec=sec)).parts["duration"]

    assert (at(402), at(405), at(415), at(500)) == (1, 0.6, 0.2, 0)
    assert score_candidate(PARSED, candidate(durationSec=None)).parts["duration"] == 0.5


def test_artists_are_found_as_whole_words():
    assert score_candidate(track("Sol - Higher State"), candidate()).parts["artist"] == 0
    both = score_candidate(track("Above and Beyond - X"), candidate(artists=["Above & Beyond"]))
    assert both.parts["artist"] == 1


def test_area_one_is_found_when_beatport_spells_it_area_ne():
    area = track("AREA ØNE - Dutch Bounce")
    for spelled, expected in (("AREA NE", 1), ("AREA ØNE", 1), ("AREA ONE", 1), ("Someone", 0)):
        assert score_candidate(area, candidate(artists=[spelled])).parts["artist"] == expected


def test_an_exact_hit_is_a_match():
    assert match_track(PARSED, [candidate()]).verdict == "match"


def test_the_right_mix_ranks_first():
    dixon = track("Solomun - Higher State (Dixon Remix)", "x", 380)
    result = match_track(dixon, [candidate(id=1), candidate(id=2, mix="Dixon Remix", durationSec=381)])
    assert result.ranked[0].candidate["id"] == 2
    assert result.verdict == "match"


def test_a_wrong_artist_with_the_same_title_and_length_is_maybe_never_match():
    assert match_track(PARSED, [candidate(artists=["Someone Else"])]).verdict == "maybe"


def test_a_title_shared_with_an_unrelated_track_is_none():
    assert match_track(PARSED, [candidate(artists=["Someone Else"], durationSec=470)]).verdict == "none"


def test_a_guessed_artist_still_gets_a_suggestion():
    guessed = track("Higher State", "Some Label", 400)
    assert match_track(guessed, [candidate(artists=["Someone Else"], durationSec=470)]).verdict == "maybe"
    assert match_track(guessed, [candidate()]).verdict == "match"


def test_an_unrelated_result_is_none_and_no_results_is_none():
    assert match_track(PARSED, [candidate(title="Completely Different", artists=["Nobody"], durationSec=90)]).verdict == "none"
    result = match_track(PARSED, [])
    assert (result.verdict, result.ranked) == ("none", [])


def test_at_most_five_candidates_best_first():
    many = [candidate(id=i, durationSec=400 + i * 20) for i in range(8)]
    result = match_track(PARSED, many)
    assert len(result.ranked) == 5
    assert result.ranked[0].candidate["id"] == 0


def test_real_playlist_matches_what_the_browser_version_decided():
    """30 real SoundCloud tracks with their real Beatport results. The expected file was produced by the TypeScript
    version this code replaced, so it pins the port; after that it pins the tuning."""
    data = json.loads((FIXTURES / "real_playlist.json").read_text(encoding="utf-8"))
    expected = json.loads((FIXTURES / "real_expected.json").read_text(encoding="utf-8"))
    assert len(data["tracks"]) == len(expected) == 30
    for source, results, want in zip(data["tracks"], data["results"], expected, strict=True):
        parsed = parse_track(source["title"], source["uploader"], source["durationSec"])
        got = match_track(parsed, results)
        context = source["title"]
        assert (parsed.artists, parsed.title, parsed.mix, parsed.artist_guessed) == (
            want["parsed"]["artists"],
            want["parsed"]["title"],
            want["parsed"]["mix"],
            want["parsed"]["artistGuessed"],
        ), context
        assert got.verdict == want["verdict"], context
        assert [s.candidate["id"] for s in got.ranked] == want["ranked"], context
        if want["best"]:
            assert got.ranked[0].candidate["id"] == want["best"]["id"], context
            assert abs(got.ranked[0].score - want["best"]["score"]) < 1e-5, context
