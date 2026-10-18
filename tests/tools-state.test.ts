import { describe, expect, it } from "vitest";
import { FILE_LIMIT, looksBinary, refuseFile } from "../src/features/tools/files";
import {
    buildHash,
    createToolState,
    LINK_LIMIT,
    PIPE_KEY,
    putPipe,
    type Store,
    splitHash,
    takePipe,
} from "../src/features/tools/state";

function memory(initial: Record<string, string> = {}): Store & { data: Record<string, string> } {
    const data = { ...initial };
    return {
        data,
        getItem: (k) => data[k] ?? null,
        setItem: (k, v) => {
            data[k] = v;
        },
        removeItem: (k) => {
            delete data[k];
        },
    };
}

const blocked: Store = {
    getItem: () => {
        throw new Error("blocked");
    },
    setItem: () => {
        throw new Error("blocked");
    },
    removeItem: () => {
        throw new Error("blocked");
    },
};

describe("splitHash", () => {
    it("splits the id from the query", () => {
        expect(splitHash("#json").id).toBe("json");
        expect(splitHash("#json?i=%7B%7D&m=minify").params.get("i")).toBe("{}");
        expect(splitHash("#json?i=a?b").params.get("i")).toBe("a?b");
        expect(splitHash("").id).toBe("");
        expect(splitHash("#a%20b").id).toBe("a b");
    });

    it("survives a malformed escape", () => {
        expect(splitHash("#%E0%A4%A").id).toBe("%E0%A4%A");
    });
});

describe("buildHash", () => {
    it("round-trips awkward text", () => {
        const text = 'line 1\nline "2" & <3> ünï ✓ ?=#';
        const { hash, dropped } = buildHash("json", { i: text, m: "format" });
        expect(dropped).toEqual([]);
        const back = splitHash(hash);
        expect(back.id).toBe("json");
        expect(back.params.get("i")).toBe(text);
        expect(back.params.get("m")).toBe("format");
    });

    it("leaves out empty values and reports values over the limit", () => {
        const { hash, dropped } = buildHash("diff", { a: "x".repeat(LINK_LIMIT + 1), b: "", c: "1" });
        expect(dropped).toEqual(["a"]);
        expect(hash).toBe("#diff?c=1");
        expect(buildHash("diff", {}).hash).toBe("#diff");
    });
});

describe("createToolState", () => {
    it("prefers the URL, then the remembered value, then the fallback", () => {
        const local = memory({ "tools:json:m": "minify" });
        expect(createToolState("json", "#json?m=validate", local, null).get("m", "format")).toBe("validate");
        expect(createToolState("json", "#json", local, null).get("m", "format")).toBe("minify");
        expect(createToolState("json", "#json", memory(), null).get("m", "format")).toBe("format");
    });

    it("skips values that are not allowed", () => {
        const local = memory({ "tools:json:m": "nope" });
        const state = createToolState("json", "#json?m=bad", local, null);
        expect(state.get("m", "format", ["format", "minify"])).toBe("format");
        expect(createToolState("json", "#json?m=minify", local, null).get("m", "format", ["format", "minify"])).toBe(
            "minify",
        );
    });

    it("clamps numbers and ignores junk", () => {
        const at = (hash: string) => createToolState("password", hash, null, null).getNumber("len", 20, 8, 64);
        expect(at("#password?len=99")).toBe(64);
        expect(at("#password?len=1")).toBe(8);
        expect(at("#password?len=abc")).toBe(20);
        expect(at("#password?len=")).toBe(20);
        expect(at("#password")).toBe(20);
    });

    it("remembers options but never text", () => {
        const local = memory();
        const state = createToolState("case", "#case", local, null);
        const box = { value: "secret text" };
        state.bindText("i", box, { primary: true });
        state.set("m", "kebab");
        expect(local.data).toEqual({ "tools:case:m": "kebab" });
    });

    it("does not remember options that came only from a link", () => {
        const local = memory();
        createToolState("case", "#case?m=kebab", local, null).get("m", "snake");
        expect(local.data).toEqual({});
    });

    it("works with blocked storage", () => {
        const state = createToolState("case", "#case", blocked, blocked);
        expect(state.get("m", "snake")).toBe("snake");
        expect(() => state.set("m", "kebab")).not.toThrow();
        expect(() => state.bindText("i", { value: "" }, { primary: true })).not.toThrow();
    });

    it("fills text boxes from the URL and builds a link that reproduces the state", () => {
        const state = createToolState("diff", "#diff?a=old&c=1", memory(), null);
        const a = { value: "" };
        const b = { value: "" };
        expect(state.get("c", "0")).toBe("1");
        state.bindText("a", a, { primary: true });
        state.bindText("b", b);
        expect(a.value).toBe("old");
        b.value = "new & better";
        state.set("s", "1");
        const link = splitHash(state.link().hash);
        expect(link.id).toBe("diff");
        expect(Object.fromEntries(link.params)).toEqual({ a: "old", b: "new & better", c: "1", s: "1" });
    });

    it("includes defaults in the link, so the receiver's own options cannot change the result", () => {
        const state = createToolState("case", "#case", memory(), null);
        state.get("m", "snake");
        expect(splitHash(state.link().hash).params.get("m")).toBe("snake");
    });

    it("keeps secrets out of links with share: false", () => {
        const state = createToolState("hash", "#hash", memory(), null);
        const key = { value: "hunter2" };
        state.bindText("k", key, { share: false });
        expect(state.link().hash).toBe("#hash");
    });
});

describe("send to another tool", () => {
    it("hands the text over once, to the primary box only", () => {
        const session = memory();
        expect(putPipe(session, "from json")).toBe(true);
        expect(session.data[PIPE_KEY]).toBe("from json");

        const state = createToolState("encode", "#encode", memory(), session);
        const other = { value: "" };
        const main = { value: "" };
        state.bindText("x", other); // not primary: leaves the handoff alone
        expect(other.value).toBe("");
        state.bindText("i", main, { primary: true });
        expect(main.value).toBe("from json");
        expect(session.data[PIPE_KEY]).toBeUndefined();

        const again = { value: "" };
        createToolState("encode", "#encode", memory(), session).bindText("i", again, { primary: true });
        expect(again.value).toBe("");
    });

    it("beats the URL text, and an empty handoff still counts", () => {
        const session = memory();
        putPipe(session, "");
        const box = { value: "" };
        createToolState("encode", "#encode?i=url", memory(), session).bindText("i", box, { primary: true });
        expect(box.value).toBe("");
    });

    it("reports blocked storage", () => {
        expect(putPipe(null, "x")).toBe(false);
        expect(putPipe(blocked, "x")).toBe(false);
        expect(takePipe(null)).toBeNull();
        expect(takePipe(blocked)).toBeNull();
    });
});

describe("dropped files", () => {
    it("tells text from binary", () => {
        expect(looksBinary("plain text\nwith lines")).toBe(false);
        expect(looksBinary("")).toBe(false);
        expect(looksBinary("PK\u0003\u0004\0\0")).toBe(true);
        expect(looksBinary("�".repeat(20) + "a".repeat(100))).toBe(true);
        expect(looksBinary(`café ✓ ${"a".repeat(500)}�`)).toBe(false); // one stray character in a long text is fine
    });

    it("refuses big and binary files", () => {
        expect(refuseFile(10, "hello")).toBeNull();
        expect(refuseFile(FILE_LIMIT + 1, "hello")).toMatch(/too big/);
        expect(refuseFile(10, "a\0b")).toBe("not a text file");
    });
});
