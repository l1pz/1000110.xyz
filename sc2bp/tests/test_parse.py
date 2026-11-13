import pytest
from parse import label, normalize, parse_track


def track(title, uploader="Some Channel", duration=None):
    return parse_track(title, uploader, duration)


def test_normalize_drops_case_accents_and_punctuation():
    assert normalize("  Café  del Mar!! ") == "cafe del mar"
    assert normalize("Above & Beyond") == "above and beyond"


def test_normalize_folds_letters_that_nfkd_leaves_alone():
    assert normalize("AREA ØNE") == "area one"
    assert normalize("Łukasz Đorđe Æ Straße") == "lukasz dorde ae strasse"


def test_splits_artist_and_title_on_a_dash():
    parsed = track("Solomun - Higher State")
    assert (parsed.artists, parsed.title, parsed.mix, parsed.artist_guessed) == (["Solomun"], "Higher State", "", False)


def test_takes_the_last_mix_looking_group_as_the_mix():
    parsed = track("Solomun - Higher State (Dixon Remix)")
    assert (parsed.title, parsed.mix) == ("Higher State", "Dixon Remix")
    assert track("Solomun - Higher State [Extended Mix]").mix == "Extended Mix"


def test_drops_junk_groups_and_trailing_free_download_text():
    assert track("Solomun - Higher State [FREE DL]").title == "Higher State"
    assert track("Solomun - Higher State (Premiere)").title == "Higher State"
    assert track("Solomun - Higher State FREE DOWNLOAD").title == "Higher State"


def test_keeps_groups_that_are_neither_junk_mix_nor_featuring():
    assert track("Solomun - Higher State (Live)").title == "Higher State (Live)"


def test_moves_featuring_credits_into_the_artists():
    parsed = track("Solomun - Higher State (feat. Jane Doe)")
    assert (parsed.artists, parsed.title) == (["Solomun", "Jane Doe"], "Higher State")
    assert track("Solomun - Higher State ft. Jane Doe").artists == ["Solomun", "Jane Doe"]
    assert track("Solomun feat. Jane Doe - Higher State").artists == ["Solomun", "Jane Doe"]


def test_splits_several_artists():
    assert track("A & B, C x D - Song").artists == ["A", "B", "C", "D"]


def test_reads_a_mix_after_a_second_dash():
    parsed = track("Solomun - Higher State - Dixon Remix")
    assert (parsed.title, parsed.mix) == ("Higher State", "Dixon Remix")


def test_falls_back_to_the_uploader_when_there_is_no_dash():
    parsed = track("Higher State", "Solomun")
    assert (parsed.artists, parsed.title, parsed.artist_guessed) == (["Solomun"], "Higher State", True)


def test_keeps_the_duration():
    assert track("A - B", "x", 372).duration_sec == 372


def test_drops_a_leading_premiere_or_free_download_in_any_case_and_with_any_separator():
    parsed = track("Premiere | AREA ØNE - Rolling Dice")
    assert (parsed.artists, parsed.title) == (["AREA ØNE"], "Rolling Dice")
    parsed = track("PREMIERE : Joey Risdon - Without Drugs [RR014]")
    assert (parsed.artists, parsed.title) == (["Joey Risdon"], "Without Drugs")
    parsed = track("FREE DOWNLOAD | Da Hool - Meet Her (RBX EDIT)")
    assert (parsed.artists, parsed.title, parsed.mix) == (["Da Hool"], "Meet Her", "RBX EDIT")
    assert track("Premiere: Free Download - A - B").artists == ["A"]


def test_drops_label_and_catalogue_tags_in_square_brackets():
    assert track("SVĒR - Back To The Sound [TTC002]").title == "Back To The Sound"
    assert track("Doruksen, Denis Dekay - MAVI [Revised Record]").title == "MAVI"
    assert track("blckr thn blck - you high baby? [No Mercy]").title == "you high baby?"
    parsed = track("Lucas Campagna - LML [TT01] (DXPE Remix)")
    assert (parsed.title, parsed.mix) == ("LML", "DXPE Remix")


def test_drops_out_now_and_a_catalogue_number_at_the_end_of_the_title():
    parsed = track("KNTRLVRLST - System Failure RCR010 OUT NOW! (Original Mix)")
    assert (parsed.artists, parsed.title, parsed.mix) == (["KNTRLVRLST"], "System Failure", "Original Mix")
    assert track("Artist - Song OUT NOW").title == "Song"
    assert track("Artist - Song - OUT NOW!").title == "Song"
    assert track("Artist - Song | Out Now").title == "Song"
    assert track("Artist - Song RCR010").title == "Song"


def test_leaves_titles_alone_that_only_look_like_a_catalogue_number():
    assert track("Artist - ABC123").title == "ABC123"
    assert track("Artist - Studio 54").title == "Studio 54"
    assert track("Artist - Route 66").title == "Route 66"
    assert track("Artist - Song Part 2").title == "Song Part 2"
    assert track("Artist - Now Out Of Time").title == "Now Out Of Time"


def test_keeps_a_mix_in_square_brackets_and_a_non_mix_group_in_parentheses():
    assert track("A - B [Dixon Remix]").mix == "Dixon Remix"
    assert track("A - B (Part 2)").title == "B (Part 2)"


@pytest.mark.parametrize("text", ["", "   ", "[]", "()", " - "])
def test_odd_titles_do_not_crash(text):
    assert track(text, "Up").title is not None


def test_label_shows_artists_title_and_mix():
    assert label(track("A - B (C Remix)")) == "A - B (C Remix)"
    assert label(track("", "")) == ""


def yt(title, uploader="Up", topic=False):
    from parse import parse_track

    return parse_track(title, uploader, 200, source="youtube", uploader_is_artist=topic)


@pytest.mark.parametrize(
    ("title", "artists", "name"),
    [
        ("Shakira, Burna Boy - Dai Dai (Official Video)", ["Shakira", "Burna Boy"], "Dai Dai"),
        ("Arcángel - FN8 ( Video Lyric )", ["Arcángel"], "FN8"),
        ("Real Boston Richey - The Type (Official Music Video) ft. YTB Fatt", ["Real Boston Richey", "YTB Fatt"], "The Type"),
        ("Becky G - POR EL CONTRARIO (Performance Video) ft. Ángela Aguilar", ["Becky G", "Ángela Aguilar"], "POR EL CONTRARIO"),
        ("KAROL G, Judeline - BbY WOW (Visualizer)", ["KAROL G", "Judeline"], "BbY WOW"),
        ("Artist - Song [Lyric Video]", ["Artist"], "Song"),
        ("Artist - Song OFFICIAL MUSIC VIDEO", ["Artist"], "Song"),
    ],
)
def test_youtube_titles_lose_their_video_dressing(title, artists, name):
    parsed = yt(title)
    assert (parsed.artists, parsed.title) == (artists, name)


def test_youtube_credits_after_a_pipe_are_dropped_and_with_becomes_featuring():
    parsed = yt("KALYANI (with Shreya Ghoshal) OFFICIAL MUSIC VIDEO | ARJN | KDS | FIFTY4", "Money Verse")
    assert (parsed.artists, parsed.title) == (["Money Verse", "Shreya Ghoshal"], "KALYANI")
    assert yt("Alfaaz | Hamza Malik x Zain Zohaib | Official Visualiser", "Hamza Malik").title == "Alfaaz"


def test_youtube_keeps_a_mix_even_when_it_says_video():
    parsed = yt("Artist - Song (Extended Video Mix)")
    assert parsed.mix == "Extended Video Mix"


def test_youtube_never_cleans_a_title_to_nothing():
    assert yt("(Official Video)").title == "(Official Video)"


def test_a_topic_channel_is_the_artist_not_a_guess():
    parsed = yt("Strobe", "deadmau5", topic=True)
    assert (parsed.artists, parsed.artist_guessed) == (["deadmau5"], False)
    assert yt("Strobe", "deadmau5").artist_guessed is True


def test_soundcloud_titles_are_not_given_the_youtube_cleanup():
    assert track("Solomun - Higher State (Official Video)").title == "Higher State (Official Video)"
