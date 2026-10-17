import { describe, expect, it } from "vitest";
import { countText, duration, rows } from "../src/features/tools/tools/count/count";

describe("countText", () => {
    it("is all zeros for empty text", () => {
        expect(countText("")).toEqual({
            characters: 0,
            noSpaces: 0,
            words: 0,
            lines: 0,
            sentences: 0,
            paragraphs: 0,
            bytes: 0,
        });
    });

    it("counts words, lines, characters", () => {
        const c = countText("Hello  world\nsecond line");
        expect(c.words).toBe(4);
        expect(c.lines).toBe(2);
        expect(c.characters).toBe(24);
        expect(c.noSpaces).toBe(20);
    });

    it("counts code points and UTF-8 bytes, not UTF-16 units", () => {
        const c = countText("a😀é");
        expect(c.characters).toBe(3);
        expect(c.bytes).toBe(1 + 4 + 2);
    });

    it("counts sentences and paragraphs", () => {
        const c = countText("One. Two! Three?\n\nFour...\n\n\n");
        expect(c.sentences).toBe(4);
        expect(c.paragraphs).toBe(2);
    });

    it("treats CRLF as one line break", () => {
        expect(countText("a\r\nb").lines).toBe(2);
    });
});

describe("duration", () => {
    it("formats minutes and hours", () => {
        expect(duration(0, 230)).toBe("0 min");
        expect(duration(10, 230)).toBe("under 1 min");
        expect(duration(690, 230)).toBe("3 min");
        expect(duration(230 * 65, 230)).toBe("1 h 05 min");
    });
});

describe("rows", () => {
    it("labels every count", () => {
        expect(rows("hi").map(([label]) => label)).toContain("reading time");
    });
});
