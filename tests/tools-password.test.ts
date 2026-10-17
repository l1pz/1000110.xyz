import { describe, expect, it } from "vitest";
import { randomInt, shuffle } from "../src/features/tools/random";
import {
    CLASSES,
    generatePassphrase,
    generatePassword,
    meter,
    type PasswordOptions,
    strength,
} from "../src/features/tools/tools/password/generate";
import { WORDS } from "../src/features/tools/tools/password/words";

/** Random bytes that replay a fixed list (wrapping), so output is predictable. */
const replay = (bytes: number[]) => {
    let at = 0;
    return (count: number) => Uint8Array.from({ length: count }, () => bytes[at++ % bytes.length]);
};

const all: PasswordOptions = {
    length: 16,
    classes: { lower: true, upper: true, digits: true, symbols: true },
    avoidAmbiguous: false,
};

describe("randomInt", () => {
    it("maps a draw to [0, max)", () => {
        expect(randomInt(10, replay([0, 0, 0, 7]))).toBe(7);
        expect(randomInt(1, replay([255, 255, 255, 255]))).toBe(0);
    });

    it("rejects draws from the biased tail instead of folding them", () => {
        // limit for max 10 is 4294967290: 0xFFFFFFFF is rejected, the next draw (0,0,0,3) is used
        expect(randomInt(10, replay([255, 255, 255, 255, 0, 0, 0, 3]))).toBe(3);
    });

    it("rejects a bad max", () => {
        expect(() => randomInt(0)).toThrow(RangeError);
        expect(() => randomInt(1.5)).toThrow(RangeError);
    });

    it("is roughly uniform", () => {
        const counts = new Array(6).fill(0);
        for (let i = 0; i < 6000; i++) counts[randomInt(6)]++;
        for (const c of counts) expect(c).toBeGreaterThan(800);
    });
});

describe("shuffle", () => {
    it("keeps the same elements", () => {
        expect(shuffle([1, 2, 3, 4, 5]).sort()).toEqual([1, 2, 3, 4, 5]);
    });
});

describe("generatePassword", () => {
    it("has the requested length and uses every selected class", () => {
        for (let i = 0; i < 50; i++) {
            const { text } = generatePassword({ ...all, length: 8 });
            expect(text).toHaveLength(8);
            for (const set of Object.values(CLASSES)) expect([...text].some((ch) => set.includes(ch))).toBe(true);
        }
    });

    it("sticks to the selected classes", () => {
        const { text } = generatePassword({
            ...all,
            classes: { lower: false, upper: false, digits: true, symbols: false },
        });
        expect(text).toMatch(/^[0-9]{16}$/);
    });

    it("can avoid look-alike characters", () => {
        for (let i = 0; i < 50; i++) {
            expect(generatePassword({ ...all, length: 64, avoidAmbiguous: true }).text).not.toMatch(/[Il1|O0o]/);
        }
    });

    it("reports entropy from the pool size", () => {
        const digits = { ...all, length: 10, classes: { lower: false, upper: false, digits: true, symbols: false } };
        expect(generatePassword(digits).bits).toBeCloseTo(10 * Math.log2(10), 10);
        const pool = Object.values(CLASSES).join("").length;
        expect(generatePassword(all).bits).toBeCloseTo(16 * Math.log2(pool), 10);
    });

    it("rejects impossible settings", () => {
        expect(() => generatePassword({ ...all, length: 3 })).toThrow(/length/);
        expect(() => generatePassword({ ...all, length: 129 })).toThrow(/length/);
        const none = { lower: false, upper: false, digits: false, symbols: false };
        expect(() => generatePassword({ ...all, classes: none })).toThrow(/class/);
    });
});

describe("generatePassphrase", () => {
    const base = { words: 4, separator: "-", capitalize: false, digit: false };

    it("joins list words with the separator", () => {
        const { text } = generatePassphrase(base);
        const parts = text.split("-");
        expect(parts).toHaveLength(4);
        for (const part of parts) expect(WORDS).toContain(part);
    });

    it("capitalizes and adds a digit, and counts the digit's entropy", () => {
        const plain = generatePassphrase(base);
        const fancy = generatePassphrase({ ...base, separator: " ", capitalize: true, digit: true });
        expect(fancy.text).toMatch(/^([A-Z][a-z]+ ){3}[A-Z][a-z]+[0-9]$/);
        expect(fancy.bits).toBeCloseTo(plain.bits + Math.log2(10), 10);
    });

    it("counts bits per word from the list size", () => {
        expect(generatePassphrase(base).bits).toBeCloseTo(4 * Math.log2(WORDS.length), 10);
    });

    it("rejects a bad word count", () => {
        expect(() => generatePassphrase({ ...base, words: 1 })).toThrow(/words/);
        expect(() => generatePassphrase({ ...base, words: 13 })).toThrow(/words/);
    });
});

describe("word list", () => {
    it("has only unique, lower case, short words", () => {
        expect(new Set(WORDS).size).toBe(WORDS.length);
        for (const w of WORDS) expect(w, w).toMatch(/^[a-z]{2,9}$/);
    });

    it("is big enough for about 8.5 bits a word", () => {
        expect(WORDS.length).toBeGreaterThanOrEqual(360);
    });
});

describe("meter", () => {
    it("labels the strength", () => {
        expect(strength(10)).toBe("weak");
        expect(strength(45)).toBe("fair");
        expect(strength(70)).toBe("good");
        expect(strength(90)).toBe("strong");
        expect(strength(128)).toBe("overkill");
    });

    it("draws a bar that is full at 128 bits and never overflows", () => {
        expect(meter(0)).toBe("[--------------------] 0 bits, weak");
        expect(meter(64)).toBe("[##########----------] 64 bits, good");
        expect(meter(500)).toBe(`[${"#".repeat(20)}] 500 bits, overkill`);
    });
});
