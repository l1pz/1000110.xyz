import { describe, expect, it } from "vitest";
import {
    generate,
    NANOID,
    nanoid,
    type Options,
    ulid,
    uuidV4,
    uuidV7,
} from "../src/features/tools/tools/uuid/generate";

const replay = (bytes: number[]) => {
    let at = 0;
    return (count: number) => Uint8Array.from({ length: count }, () => bytes[at++ % bytes.length]);
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-([47])[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("uuid v4", () => {
    it("sets the version and variant bits on all-ones and all-zeros input", () => {
        expect(uuidV4(replay([255]))).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
        expect(uuidV4(replay([0]))).toBe("00000000-0000-4000-8000-000000000000");
    });

    it("looks like a v4 uuid and differs between calls", () => {
        const a = uuidV4();
        expect(a).toMatch(UUID);
        expect(a[14]).toBe("4");
        expect(uuidV4()).not.toBe(a);
    });
});

describe("uuid v7", () => {
    it("puts the 48-bit millisecond time first", () => {
        const ms = 0x018f0000abcd;
        const id = uuidV7(replay([0]), ms);
        expect(id).toBe("018f0000-abcd-7000-8000-000000000000");
    });

    it("sorts by time", () => {
        const earlier = uuidV7(replay([255]), 1_700_000_000_000);
        const later = uuidV7(replay([0]), 1_700_000_000_001);
        expect(earlier < later).toBe(true);
        expect(later).toMatch(UUID);
        expect(later[14]).toBe("7");
    });
});

describe("ulid", () => {
    it("encodes the time as the spec example does", () => {
        // From the ULID spec: 1469918176385 ms is 01ARYZ6S41
        expect(ulid(replay([0]), 1469918176385).slice(0, 10)).toBe("01ARYZ6S41");
    });

    it("is 26 Crockford characters and sorts by time", () => {
        const a = ulid(replay([31]), 1_700_000_000_000);
        const b = ulid(replay([0]), 1_700_000_000_001);
        expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
        expect(a < b).toBe(true);
    });
});

describe("nanoid", () => {
    it("has the requested length and only url-safe characters", () => {
        expect(nanoid()).toHaveLength(NANOID.size);
        expect(nanoid(64)).toMatch(/^[A-Za-z0-9_-]{64}$/);
    });

    it("rejects a bad size", () => {
        expect(() => nanoid(3)).toThrow(/size/);
        expect(() => nanoid(65)).toThrow(/size/);
    });
});

describe("generate", () => {
    const base: Options = { kind: "uuid4", count: 3, upper: false, hyphens: true, size: 21 };

    it("returns one id per line", () => {
        const lines = generate(base).split("\n");
        expect(lines).toHaveLength(3);
        for (const line of lines) expect(line).toMatch(UUID);
    });

    it("can upper-case and drop the hyphens", () => {
        expect(generate({ ...base, count: 1, upper: true, hyphens: false })).toMatch(/^[0-9A-F]{32}$/);
    });

    it("ignores the uuid options for ULID and NanoID", () => {
        expect(generate({ ...base, kind: "ulid", count: 1, upper: false })).toMatch(/^[0-9A-Z]{26}$/);
        expect(generate({ ...base, kind: "nanoid", count: 1, size: 10 })).toHaveLength(10);
    });

    it("rejects a bad count", () => {
        expect(() => generate({ ...base, count: 0 })).toThrow(/count/);
        expect(() => generate({ ...base, count: 101 })).toThrow(/count/);
    });
});
