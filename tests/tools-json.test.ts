import { describe, expect, it } from "vitest";
import { findError, formatJson, JsonError, lineColumn } from "../src/features/tools/tools/json/format";

const opts = { mode: "format", indent: "2", sortKeys: false } as const;

describe("formatJson", () => {
    it("formats with 2 spaces, 4 spaces or tabs", () => {
        expect(formatJson('{"a":[1,2]}', opts)).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
        expect(formatJson('{"a":1}', { ...opts, indent: "4" })).toBe('{\n    "a": 1\n}');
        expect(formatJson('{"a":1}', { ...opts, indent: "tab" })).toBe('{\n\t"a": 1\n}');
    });

    it("minifies", () => {
        expect(formatJson('{ "a" : [ 1, 2 ] }', { ...opts, mode: "minify" })).toBe('{"a":[1,2]}');
    });

    it("validates without printing the document", () => {
        expect(formatJson('{"a":1}', { ...opts, mode: "validate" })).toBe("valid JSON");
    });

    it("sorts keys at every depth but keeps array order", () => {
        const out = formatJson('{"b":1,"a":{"d":1,"c":[{"z":1,"y":2}]}}', { ...opts, mode: "minify", sortKeys: true });
        expect(out).toBe('{"a":{"c":[{"y":2,"z":1}],"d":1},"b":1}');
    });

    it("gives empty output for empty input", () => {
        expect(formatJson("  \n", opts)).toBe("");
    });

    it("throws JsonError for bad JSON", () => {
        expect(() => formatJson('{\n  "a": ,\n}', opts)).toThrow(JsonError);
    });

    it("says where the text stops being JSON", () => {
        expect(() => formatJson('{\n  "a": ,\n}', opts)).toThrow("Unexpected ',' (line 2, column 8)");
        expect(() => formatJson('{"a": 1,}', opts)).toThrow(/line 1, column 9/);
        expect(() => formatJson("[1, 2", opts)).toThrow(/Unexpected end of JSON/);
        expect(() => formatJson("{} x", opts)).toThrow(/after the end/);
        expect(() => formatJson("{'a': 1}", opts)).toThrow(/Unexpected ''' \(line 1, column 2\)/);
    });
});

describe("findError", () => {
    it("agrees with JSON.parse on what is valid", () => {
        const samples = ['{"a":[1,-2.5e3,true,false,null,"x\\u00e9\\n"]}', "[]", "{}", '"s"', "0", " [ ] "];
        for (const s of samples) {
            expect(() => JSON.parse(s)).not.toThrow();
            expect(findError(s)).toBeNull();
        }
        for (const s of ["01", "[1,]", '{"a"}', '"\\x"', '"a\nb"', "tru", "-", "[", ""]) {
            expect(() => JSON.parse(s)).toThrow();
            expect(findError(s)).not.toBeNull();
        }
    });
});

describe("lineColumn", () => {
    it("counts from 1", () => {
        expect(lineColumn("abc", 0)).toEqual({ line: 1, column: 1 });
        expect(lineColumn("ab\ncd", 4)).toEqual({ line: 2, column: 2 });
    });
});
