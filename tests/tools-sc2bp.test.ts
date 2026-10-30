import { describe, expect, it } from "vitest";
import { type Candidate, matchTrack, scoreCandidate, similarity } from "../src/features/tools/tools/sc2bp/match";
import { normalize, parseTrack } from "../src/features/tools/tools/sc2bp/parse";

const track = (title: string, uploader = "Some Channel", durationSec: number | null = null) =>
    parseTrack({ title, uploader, durationSec });

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
    id: 1,
    title: "Higher State",
    mix: "Original Mix",
    artists: ["Solomun"],
    durationSec: 400,
    ...over,
});

describe("normalize", () => {
    it("drops case, accents and punctuation", () => {
        expect(normalize("  Café  del Mar!! ")).toBe("cafe del mar");
        expect(normalize("Above & Beyond")).toBe("above and beyond");
    });
});

describe("parseTrack", () => {
    it("splits artist and title on a dash", () => {
        expect(track("Solomun - Higher State")).toMatchObject({
            artists: ["Solomun"],
            title: "Higher State",
            mix: "",
            artistGuessed: false,
        });
    });

    it("takes the last mix-looking group as the mix", () => {
        expect(track("Solomun - Higher State (Dixon Remix)")).toMatchObject({
            title: "Higher State",
            mix: "Dixon Remix",
        });
        expect(track("Solomun - Higher State [Extended Mix]").mix).toBe("Extended Mix");
    });

    it("drops junk groups and trailing free-download text", () => {
        expect(track("Solomun - Higher State [FREE DL]").title).toBe("Higher State");
        expect(track("Solomun - Higher State (Premiere)").title).toBe("Higher State");
        expect(track("Solomun - Higher State FREE DOWNLOAD").title).toBe("Higher State");
    });

    it("keeps groups that are neither junk, mix nor featuring", () => {
        expect(track("Solomun - Higher State (Live)").title).toBe("Higher State (Live)");
    });

    it("moves featuring credits into the artists", () => {
        expect(track("Solomun - Higher State (feat. Jane Doe)")).toMatchObject({
            artists: ["Solomun", "Jane Doe"],
            title: "Higher State",
        });
        expect(track("Solomun - Higher State ft. Jane Doe").artists).toEqual(["Solomun", "Jane Doe"]);
        expect(track("Solomun feat. Jane Doe - Higher State").artists).toEqual(["Solomun", "Jane Doe"]);
    });

    it("splits several artists", () => {
        expect(track("A & B, C x D - Song").artists).toEqual(["A", "B", "C", "D"]);
    });

    it("reads a mix after a second dash", () => {
        expect(track("Solomun - Higher State - Dixon Remix")).toMatchObject({
            title: "Higher State",
            mix: "Dixon Remix",
        });
    });

    it("falls back to the uploader when there is no dash", () => {
        expect(track("Higher State", "Solomun")).toMatchObject({
            artists: ["Solomun"],
            title: "Higher State",
            artistGuessed: true,
        });
    });

    it("keeps the duration", () => {
        expect(track("A - B", "x", 372).durationSec).toBe(372);
    });
});

describe("similarity", () => {
    it("is 1 for equal text and 0 for nothing in common", () => {
        expect(similarity("abc", "abc")).toBe(1);
        expect(similarity("abcd", "wxyz")).toBe(0);
        expect(similarity("a", "b")).toBe(0);
    });

    it("is high for a small typo", () => {
        expect(similarity("higher state", "higher stat")).toBeGreaterThan(0.85);
    });
});

describe("scoreCandidate", () => {
    const parsed = track("Solomun - Higher State", "x", 400);

    it("scores an exact original at 1", () => {
        expect(scoreCandidate(parsed, candidate()).score).toBeCloseTo(1, 5);
    });

    it("treats an extended mix as a near fit for a title without a mix", () => {
        expect(scoreCandidate(parsed, candidate({ mix: "Extended Mix" })).parts.mix).toBe(0.8);
    });

    it("penalises a remix when the title names none", () => {
        expect(scoreCandidate(parsed, candidate({ mix: "Dixon Remix" })).parts.mix).toBe(0.3);
    });

    it("grades the duration gap", () => {
        const at = (sec: number) => scoreCandidate(parsed, candidate({ durationSec: sec })).parts.duration;
        expect(at(402)).toBe(1);
        expect(at(405)).toBe(0.6);
        expect(at(415)).toBe(0.2);
        expect(at(500)).toBe(0);
        expect(scoreCandidate(parsed, candidate({ durationSec: null })).parts.duration).toBe(0.5);
    });

    it("finds artists as whole words", () => {
        expect(scoreCandidate(track("Sol - Higher State"), candidate()).parts.artist).toBe(0);
        expect(
            scoreCandidate(track("Above and Beyond - X"), candidate({ artists: ["Above & Beyond"] })).parts.artist,
        ).toBe(1);
    });
});

describe("matchTrack", () => {
    const parsed = track("Solomun - Higher State", "x", 400);

    it("calls an exact hit a match", () => {
        expect(matchTrack(parsed, [candidate()]).verdict).toBe("match");
    });

    it("ranks the right mix first", () => {
        const dixon = track("Solomun - Higher State (Dixon Remix)", "x", 380);
        const result = matchTrack(dixon, [
            candidate({ id: 1 }),
            candidate({ id: 2, mix: "Dixon Remix", artists: ["Solomun"], durationSec: 381 }),
        ]);
        expect(result.ranked[0].candidate.id).toBe(2);
        expect(result.verdict).toBe("match");
    });

    it("sends a wrong artist with the same title to maybe, never match", () => {
        const result = matchTrack(parsed, [candidate({ artists: ["Someone Else"] })]);
        expect(result.verdict).toBe("maybe");
    });

    it("calls an unrelated result none", () => {
        const result = matchTrack(parsed, [
            candidate({ title: "Completely Different", artists: ["Nobody"], durationSec: 90 }),
        ]);
        expect(result.verdict).toBe("none");
    });

    it("returns none for no results", () => {
        expect(matchTrack(parsed, [])).toEqual({ verdict: "none", ranked: [] });
    });

    it("does not need the artist to match when the artist was only guessed", () => {
        const guessed = track("Higher State", "Some Label", 400);
        expect(matchTrack(guessed, [candidate()]).verdict).toBe("match");
    });

    it("keeps at most five candidates, best first", () => {
        const many = Array.from({ length: 8 }, (_, i) => candidate({ id: i, durationSec: 400 + i * 20 }));
        const result = matchTrack(parsed, many);
        expect(result.ranked).toHaveLength(5);
        expect(result.ranked[0].candidate.id).toBe(0);
    });
});
