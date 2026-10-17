import { describe, expect, it } from "vitest";
import { explain } from "../src/features/tools/tools/regex/explain";
import { MAX_MATCHES, RegexError, runRegex, segments } from "../src/features/tools/tools/regex/run";

describe("runRegex", () => {
    it("finds all matches with the g flag and only the first without", () => {
        expect(runRegex("\\d+", "g", "a1 b22 c333").matches.map((m) => m.text)).toEqual(["1", "22", "333"]);
        expect(runRegex("\\d+", "", "a1 b22").matches.map((m) => m.text)).toEqual(["1"]);
    });

    it("reports positions, groups and named groups", () => {
        const [m] = runRegex("(?<year>\\d{4})-(\\d{2})(x)?", "g", "on 2026-10").matches;
        expect(m.index).toBe(3);
        expect(m.groups).toEqual(["2026", "10", undefined]);
        expect(m.named).toEqual({ year: "2026" });
    });

    it("honours the i flag", () => {
        expect(runRegex("abc", "gi", "xABCx").total).toBe(1);
    });

    it("does not loop on empty matches", () => {
        expect(runRegex("x*", "g", "ab").total).toBe(3);
    });

    it("returns nothing for an empty pattern and throws RegexError for a bad one", () => {
        expect(runRegex("", "g", "abc")).toEqual({ matches: [], total: 0 });
        expect(() => runRegex("(", "g", "abc")).toThrow(RegexError);
        expect(() => runRegex("a", "gg", "abc")).toThrow(RegexError);
    });

    it("keeps at most MAX_MATCHES but counts them all", () => {
        const r = runRegex("a", "g", "a".repeat(MAX_MATCHES + 25));
        expect(r.matches).toHaveLength(MAX_MATCHES);
        expect(r.total).toBe(MAX_MATCHES + 25);
    });
});

describe("segments", () => {
    it("splits plain and matched text and keeps the original string", () => {
        const text = "a1b22";
        const parts = segments(text, runRegex("\\d+", "g", text).matches);
        expect(parts).toEqual([{ text: "a" }, { text: "1", match: 0 }, { text: "b" }, { text: "22", match: 1 }]);
        expect(parts.map((p) => p.text).join("")).toBe(text);
    });

    it("skips empty matches", () => {
        expect(segments("ab", runRegex("x*", "g", "ab").matches)).toEqual([{ text: "ab" }]);
    });
});

describe("explain", () => {
    const tokens = (p: string) => explain(p).map((s) => s.token);

    it("splits a pattern into tokens", () => {
        expect(tokens("^(\\d+)-[a-z]{2,3}$")).toEqual(["^", "(", "\\d", "+", ")", "-", "[a-z]", "{2,3}", "$"]);
    });

    it("explains quantifiers, classes and anchors", () => {
        expect(explain("a+?")[1].meaning).toBe("one or more times, as few as possible");
        expect(explain("a{3}")[1].meaning).toBe("exactly 3 times");
        expect(explain("a{3,}")[1].meaning).toBe("3 or more times");
        expect(explain("[^0-9]")[0].meaning).toBe("any character except: 0-9");
        expect(explain("\\bx")[0].meaning).toBe("a word boundary");
    });

    it("names groups and indents their contents", () => {
        const steps = explain("(?<id>a)|(?:b)");
        expect(steps[0].meaning).toBe('start of capture group "id"');
        expect(steps[1].depth).toBe(1);
        expect(steps.find((s) => s.token === "|")?.depth).toBe(0);
        expect(steps.find((s) => s.token === "(?:")?.meaning).toBe("start of non-capturing group");
    });

    it("explains lookarounds and backreferences", () => {
        expect(explain("(?=a)")[0].meaning).toContain("lookahead");
        expect(explain("(?<!a)")[0].meaning).toContain("negative lookbehind");
        expect(explain("(a)\\1")[3].meaning).toBe("the same text as group 1");
    });

    it("never throws on odd input", () => {
        for (const p of ["(", ")", "[abc", "\\", "a{", "{1,2}", "😀+", "(?<n"]) {
            expect(() => explain(p)).not.toThrow();
        }
    });
});
