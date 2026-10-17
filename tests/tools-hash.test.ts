import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type AlgorithmId, hashAll, hashText, toHex } from "../src/features/tools/tools/hash/digest";
import { md5 } from "../src/features/tools/tools/hash/md5";

const fox = "The quick brown fox jumps over the lazy dog";
const NODE_NAMES: Record<AlgorithmId, string> = { md5: "md5", sha1: "sha1", sha256: "sha256", sha512: "sha512" };

describe("known digests", () => {
    it("matches the standard vectors", async () => {
        expect(await hashText("md5", "")).toBe("d41d8cd98f00b204e9800998ecf8427e");
        expect(await hashText("md5", "abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
        expect(await hashText("md5", fox)).toBe("9e107d9d372bb6826bd81d3542a419d6");
        expect(await hashText("sha1", "abc")).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
        expect(await hashText("sha256", "abc")).toBe(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        );
        expect(await hashText("sha512", "abc")).toBe(
            "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
        );
    });

    it("hashes UTF-8 bytes, not code units", async () => {
        for (const id of Object.keys(NODE_NAMES) as AlgorithmId[]) {
            const expected = createHash(NODE_NAMES[id]).update("héllo 🌍", "utf8").digest("hex");
            expect(await hashText(id, "héllo 🌍"), id).toBe(expected);
        }
    });
});

describe("md5 padding edges", () => {
    it("agrees with node around the 56 and 64 byte boundaries", () => {
        for (const len of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
            const data = Uint8Array.from({ length: len }, (_, i) => (i * 7 + 3) & 0xff);
            expect(toHex(md5(data)), `${len} bytes`).toBe(createHash("md5").update(data).digest("hex"));
        }
    });
});

describe("hmac", () => {
    it("matches the published vectors", async () => {
        expect(await hashText("md5", fox, "key")).toBe("80070713463e7749b90c2dc24911e275");
        expect(await hashText("sha1", fox, "key")).toBe("de7c9b85b8b78aa6bc8a7a36f70a90701c9db4d9");
        expect(await hashText("sha256", fox, "key")).toBe(
            "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
        );
    });

    it("agrees with node for short, block-sized and over-long keys", async () => {
        for (const id of Object.keys(NODE_NAMES) as AlgorithmId[]) {
            for (const key of ["k", "k".repeat(64), "k".repeat(128), "k".repeat(200)]) {
                const expected = createHmac(NODE_NAMES[id], key).update(fox).digest("hex");
                expect(await hashText(id, fox, key), `${id} key ${key.length}`).toBe(expected);
            }
        }
    });
});

describe("output format", () => {
    it("can upper-case the hex", async () => {
        expect(await hashText("md5", "abc", "", true)).toBe("900150983CD24FB0D6963F7D28E17F72");
    });

    it("lists every algorithm with aligned labels", async () => {
        const lines = (await hashAll("abc")).split("\n");
        expect(lines).toHaveLength(4);
        expect(lines[0]).toBe("MD5      900150983cd24fb0d6963f7d28e17f72");
        expect(lines[3].startsWith("SHA-512  ")).toBe(true);
    });
});
