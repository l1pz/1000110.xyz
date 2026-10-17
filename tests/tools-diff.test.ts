import { describe, expect, it } from "vitest";
import { DiffTooBig, diffLines, MAX_CELLS, summary } from "../src/features/tools/tools/diff/diff";

const plain = { ignoreCase: false, ignoreSpace: false };
const MARK = { same: " ", add: "+", del: "-" } as const;
const show = (a: string, b: string, o = plain) => diffLines(a, b, o).map((l) => MARK[l.kind] + l.text);

describe("diffLines", () => {
    it("marks changes, additions and removals", () => {
        expect(show("a\nb\nc", "a\nx\nc")).toEqual([" a", "-b", "+x", " c"]);
        expect(show("a\nc", "a\nb\nc")).toEqual([" a", "+b", " c"]);
        expect(show("a\nb\nc", "a\nc")).toEqual([" a", "-b", " c"]);
    });

    it("finds the common lines in the middle", () => {
        expect(show("1\n2\n3\n4", "2\n4\n5")).toEqual(["-1", " 2", "-3", " 4", "+5"]);
    });

    it("handles empty sides", () => {
        expect(show("", "a")).toEqual(["+a"]);
        expect(show("a", "")).toEqual(["-a"]);
        expect(show("", "")).toEqual([]);
    });

    it("is identical for equal text, whatever the line endings", () => {
        expect(summary(diffLines("a\r\nb", "a\nb", plain))).toBe("identical");
    });

    it("ignores case and spacing on request, but shows the new text", () => {
        expect(show("Hello  World", "hello world")).toEqual(["-Hello  World", "+hello world"]);
        expect(show("Hello  World", "hello world", { ignoreCase: true, ignoreSpace: true })).toEqual([" hello world"]);
    });

    it("summarizes", () => {
        expect(summary(diffLines("a\nb", "a\nc\nd", plain))).toBe("+2 -1");
    });

    it("refuses inputs that would need a huge table", () => {
        const side = (prefix: string) =>
            Array.from({ length: Math.ceil(Math.sqrt(MAX_CELLS)) + 10 }, (_, i) => `${prefix}${i}`).join("\n");
        expect(() => diffLines(side("a"), side("b"), plain)).toThrow(DiffTooBig);
    });
});
