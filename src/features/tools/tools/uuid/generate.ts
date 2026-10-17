import { type RandomBytes, randomInt, systemRandom } from "../../random";

export const KINDS = [
    { id: "uuid4", label: "UUID v4" },
    { id: "uuid7", label: "UUID v7" },
    { id: "ulid", label: "ULID" },
    { id: "nanoid", label: "NanoID" },
] as const;

export type Kind = (typeof KINDS)[number]["id"];

export const NANOID = {
    alphabet: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-",
    size: 21,
    min: 4,
    max: 64,
} as const;

/** Crockford base32: no I, L, O or U. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function formatUuid(b: Uint8Array): string {
    const hex = Array.from(b, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Random UUID (RFC 9562 version 4). */
export function uuidV4(rand: RandomBytes = systemRandom): string {
    const b = rand(16).slice();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    return formatUuid(b);
}

/** Time-ordered UUID (RFC 9562 version 7): 48 bits of Unix milliseconds, then random bits. */
export function uuidV7(rand: RandomBytes = systemRandom, now: number = Date.now()): string {
    const b = rand(16).slice();
    let ms = Math.floor(now);
    for (let i = 5; i >= 0; i--) {
        b[i] = ms % 256;
        ms = Math.floor(ms / 256);
    }
    b[6] = (b[6] & 0x0f) | 0x70;
    b[8] = (b[8] & 0x3f) | 0x80;
    return formatUuid(b);
}

/** 26 characters: 10 of Unix milliseconds, then 16 random ones (80 bits). */
export function ulid(rand: RandomBytes = systemRandom, now: number = Date.now()): string {
    let ms = Math.floor(now);
    let time = "";
    for (let i = 0; i < 10; i++) {
        time = CROCKFORD[ms % 32] + time;
        ms = Math.floor(ms / 32);
    }
    let tail = "";
    for (let i = 0; i < 16; i++) tail += CROCKFORD[randomInt(32, rand)];
    return time + tail;
}

export function nanoid(size: number = NANOID.size, rand: RandomBytes = systemRandom): string {
    if (!Number.isInteger(size) || size < NANOID.min || size > NANOID.max) {
        throw new RangeError(`size must be ${NANOID.min} to ${NANOID.max}`);
    }
    let id = "";
    for (let i = 0; i < size; i++) id += NANOID.alphabet[randomInt(NANOID.alphabet.length, rand)];
    return id;
}

export interface Options {
    kind: Kind;
    count: number;
    /** UUIDs only. */
    upper: boolean;
    /** UUIDs only: drop the dashes. */
    hyphens: boolean;
    size: number;
}

/** One id per line. */
export function generate(options: Options, rand: RandomBytes = systemRandom, now: number = Date.now()): string {
    if (!Number.isInteger(options.count) || options.count < 1 || options.count > 100) {
        throw new RangeError("count must be 1 to 100");
    }
    const one = (): string => {
        switch (options.kind) {
            case "uuid4":
            case "uuid7": {
                let id = options.kind === "uuid4" ? uuidV4(rand) : uuidV7(rand, now);
                if (!options.hyphens) id = id.replaceAll("-", "");
                return options.upper ? id.toUpperCase() : id;
            }
            case "ulid":
                return ulid(rand, now);
            case "nanoid":
                return nanoid(options.size, rand);
        }
    };
    return Array.from({ length: options.count }, one).join("\n");
}
