import { describe, expect, it } from "vitest";
import { rankTools } from "../src/features/tools/palette";
import { loadTools } from "../src/features/tools/registry";
import type { ToolMeta } from "../src/features/tools/types";

const t = (id: string, summary: string, category: ToolMeta["category"] = "text"): ToolMeta => ({
    id,
    title: `${id} tool`,
    category,
    summary,
});

const tools = [
    t("case", "UPPER, camelCase, snake_case"),
    t("hash", "MD5, SHA-256 and HMAC", "crypto"),
    t("json", "format and validate JSON"),
    t("diff", "compare two texts"),
    t("encode", "base64, hex, url"),
];

const ids = (q: string) => rankTools(q, tools).map((x) => x.id);

describe("rankTools", () => {
    it("returns everything, in order, for an empty query", () => {
        expect(ids("")).toEqual(["case", "hash", "json", "diff", "encode"]);
        expect(ids("   ")).toEqual(["case", "hash", "json", "diff", "encode"]);
    });

    it("puts an exact id first, then a prefix, then the rest", () => {
        expect(ids("json")[0]).toBe("json");
        expect(ids("en")[0]).toBe("encode");
        expect(ids("code")[0]).toBe("encode");
    });

    it("searches titles, summaries and categories, ignoring case", () => {
        expect(ids("HMAC")).toEqual(["hash"]);
        expect(ids("crypto")).toEqual(["hash"]);
        expect(ids("base64")).toEqual(["encode"]);
        expect(ids("COMPARE")).toEqual(["diff"]);
    });

    it("matches letters in order inside an id", () => {
        expect(ids("jsn")).toEqual(["json"]);
        expect(ids("hsh")).toEqual(["hash"]);
    });

    it("needs every word to match", () => {
        expect(ids("json validate")).toEqual(["json"]);
        expect(ids("json compare")).toEqual([]);
    });

    it("finds nothing for nonsense and does not change the input list", () => {
        const copy = [...tools];
        expect(ids("zzzz")).toEqual([]);
        expect(tools).toEqual(copy);
    });
});

describe("pipe flag in the registry", () => {
    const meta = (pipe: unknown) => ({ "./tools/a/meta.ts": { meta: { ...t("a", "x"), pipe } } });
    it("accepts true, false and nothing", () => {
        expect(loadTools(meta(true))[0].pipe).toBe(true);
        expect(loadTools(meta(undefined))[0].pipe).toBeUndefined();
    });
    it("rejects anything else", () => {
        expect(() => loadTools(meta("yes"))).toThrow(/pipe/);
    });
});
