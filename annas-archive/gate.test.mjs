import { describe, expect, test } from "vitest";
import { authorized, handler, sha256 } from "./gate.mjs";

// Never the owner's real key: this file is public.
const KEY = "not-a-real-key-0123456789abcdef";
const HASH = sha256(KEY);

function call(request) {
    const out = { status: 0, body: "" };
    const res = {
        writeHead(status) {
            out.status = status;
        },
        end(body) {
            out.body = body || "";
        },
    };
    handler(HASH)(request, res);
    return out;
}

describe("sha256", () => {
    test("is the known vector for abc", () => {
        expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    });
});

describe("authorized", () => {
    test("accepts the owner's key", () => {
        expect(authorized(`Bearer ${KEY}`, HASH)).toBe(true);
    });

    test("accepts another case on Bearer and surrounding spaces", () => {
        expect(authorized(`bearer   ${KEY}  `, HASH)).toBe(true);
        expect(authorized(`BeArEr\t${KEY}`, HASH)).toBe(true);
    });

    test("accepts the stored hash in upper case", () => {
        expect(authorized(`Bearer ${KEY}`, HASH.toUpperCase())).toBe(true);
    });

    test("rejects any other key", () => {
        expect(authorized(`Bearer ${KEY}x`, HASH)).toBe(false);
        expect(authorized(`Bearer ${KEY.slice(0, -1)}`, HASH)).toBe(false);
        expect(authorized("Bearer another-key", HASH)).toBe(false);
    });

    test("rejects missing and non-Bearer headers", () => {
        for (const header of [undefined, null, "", KEY, "Bearer", "Bearer ", "Basic abc", `Token ${KEY}`]) {
            expect(authorized(header, HASH)).toBe(false);
        }
    });

    test("rejects an unusable stored hash instead of opening up", () => {
        for (const expected of ["", "nope", "a".repeat(63), "g".repeat(64), undefined]) {
            expect(authorized(`Bearer ${KEY}`, expected)).toBe(false);
        }
    });
});

describe("handler", () => {
    test("200 for the owner's key on /check", () => {
        expect(call({ url: "/check", headers: { authorization: `Bearer ${KEY}` } })).toEqual({ status: 200, body: "" });
        expect(call({ url: "/check?x=1", headers: { authorization: `Bearer ${KEY}` } }).status).toBe(200);
    });

    test("401 without the key, and nothing is proxied", () => {
        const out = call({ url: "/check", headers: {} });
        expect(out.status).toBe(401);
        expect(JSON.parse(out.body)).toEqual({ error: "unauthorized" });
    });

    test("401 for the same request with a different key", () => {
        expect(call({ url: "/check", headers: { authorization: "Bearer someone-elses" } }).status).toBe(401);
    });

    test("health needs no key and other paths are 404", () => {
        expect(call({ url: "/health", headers: {} })).toEqual({ status: 200, body: '{"ok":true}' });
        expect(call({ url: "/", headers: {} }).status).toBe(404);
    });
});