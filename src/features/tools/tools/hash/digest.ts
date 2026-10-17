import { md5 } from "./md5";

export const ALGORITHMS = [
    { id: "md5", label: "MD5", blockSize: 64 },
    { id: "sha1", label: "SHA-1", blockSize: 64 },
    { id: "sha256", label: "SHA-256", blockSize: 64 },
    { id: "sha512", label: "SHA-512", blockSize: 128 },
] as const;

export type AlgorithmId = (typeof ALGORITHMS)[number]["id"];

const SUBTLE_NAMES: Record<Exclude<AlgorithmId, "md5">, string> = {
    sha1: "SHA-1",
    sha256: "SHA-256",
    sha512: "SHA-512",
};

const encoder = new TextEncoder();

function algorithm(id: AlgorithmId) {
    const found = ALGORITHMS.find((a) => a.id === id);
    if (!found) throw new Error(`unknown algorithm "${id}"`);
    return found;
}

export async function digest(id: AlgorithmId, data: Uint8Array): Promise<Uint8Array> {
    if (id === "md5") return md5(data);
    return new Uint8Array(await crypto.subtle.digest(SUBTLE_NAMES[id], data as BufferSource));
}

/** HMAC (RFC 2104) on top of `digest`, so MD5 gets it too. */
export async function hmac(id: AlgorithmId, key: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
    const { blockSize } = algorithm(id);
    const block = new Uint8Array(blockSize);
    block.set(key.length > blockSize ? await digest(id, key) : key);

    const inner = new Uint8Array(blockSize + message.length);
    inner.set(block.map((byte) => byte ^ 0x36));
    inner.set(message, blockSize);
    const innerHash = await digest(id, inner);

    const outer = new Uint8Array(blockSize + innerHash.length);
    outer.set(block.map((byte) => byte ^ 0x5c));
    outer.set(innerHash, blockSize);
    return digest(id, outer);
}

export function toHex(bytes: Uint8Array, upper = false): string {
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return upper ? hex.toUpperCase() : hex;
}

/** Hash (or HMAC, when `key` is not empty) of UTF-8 text as hex. */
export async function hashText(id: AlgorithmId, text: string, key = "", upper = false): Promise<string> {
    const data = encoder.encode(text);
    const bytes = key === "" ? await digest(id, data) : await hmac(id, encoder.encode(key), data);
    return toHex(bytes, upper);
}

/** One `LABEL  hex` line per algorithm, labels padded to the same width. */
export async function hashAll(text: string, key = "", upper = false): Promise<string> {
    const width = Math.max(...ALGORITHMS.map((a) => a.label.length));
    const lines = await Promise.all(
        ALGORITHMS.map(async (a) => `${a.label.padEnd(width)}  ${await hashText(a.id, text, key, upper)}`),
    );
    return lines.join("\n");
}
