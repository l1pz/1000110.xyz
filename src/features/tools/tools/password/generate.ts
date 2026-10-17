import { pick, type RandomBytes, systemRandom } from "../../random";
import { WORDS } from "./words";

export const CLASSES = {
    lower: "abcdefghijklmnopqrstuvwxyz",
    upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    digits: "0123456789",
    symbols: "!@#$%^&*()-_=+[]{};:,.?/",
} as const;

export type CharClass = keyof typeof CLASSES;

/** Characters that are easy to misread: I l 1 | O 0 o. */
const AMBIGUOUS = new Set("Il1|O0o");

export const LIMITS = { minLength: 4, maxLength: 128, minWords: 2, maxWords: 12 } as const;

export interface PasswordOptions {
    length: number;
    classes: Record<CharClass, boolean>;
    avoidAmbiguous: boolean;
}

export interface PassphraseOptions {
    words: number;
    separator: string;
    capitalize: boolean;
    /** Append one random digit to the end. */
    digit: boolean;
}

export interface Generated {
    text: string;
    /** Estimated entropy in bits, from the pool size and the length. */
    bits: number;
}

/** The characters each selected class contributes, with look-alikes removed when asked. */
function pools(options: PasswordOptions): string[][] {
    return (Object.keys(CLASSES) as CharClass[])
        .filter((name) => options.classes[name])
        .map((name) => [...CLASSES[name]].filter((ch) => !(options.avoidAmbiguous && AMBIGUOUS.has(ch))));
}

/**
 * Uniform over all strings of `length` that use every selected class at least once (rejection sampling, so
 * no class is favoured). The entropy is the plain `length * log2(pool)`, which is a hair too high for very
 * short passwords and exact enough above 12 characters.
 */
export function generatePassword(options: PasswordOptions, rand: RandomBytes = systemRandom): Generated {
    const { length } = options;
    if (!Number.isInteger(length) || length < LIMITS.minLength || length > LIMITS.maxLength) {
        throw new RangeError(`length must be ${LIMITS.minLength} to ${LIMITS.maxLength}`);
    }
    const groups = pools(options);
    if (groups.length === 0) throw new RangeError("pick at least one character class");
    const pool = groups.flat();
    const hasAll = (chars: string[]) => groups.every((group) => chars.some((ch) => group.includes(ch)));

    let chars: string[];
    do {
        chars = Array.from({ length }, () => pick(pool, rand));
    } while (!hasAll(chars));
    return { text: chars.join(""), bits: length * Math.log2(pool.length) };
}

export function generatePassphrase(options: PassphraseOptions, rand: RandomBytes = systemRandom): Generated {
    const { words } = options;
    if (!Number.isInteger(words) || words < LIMITS.minWords || words > LIMITS.maxWords) {
        throw new RangeError(`words must be ${LIMITS.minWords} to ${LIMITS.maxWords}`);
    }
    const chosen = Array.from({ length: words }, () => pick(WORDS, rand));
    const shown = options.capitalize ? chosen.map((w) => w[0].toUpperCase() + w.slice(1)) : chosen;
    let text = shown.join(options.separator);
    let bits = words * Math.log2(WORDS.length);
    if (options.digit) {
        text += pick([...CLASSES.digits], rand);
        bits += Math.log2(10);
    }
    return { text, bits };
}

const STRENGTHS = [
    { below: 40, label: "weak" },
    { below: 60, label: "fair" },
    { below: 80, label: "good" },
    { below: 100, label: "strong" },
    { below: Number.POSITIVE_INFINITY, label: "overkill" },
] as const;

export function strength(bits: number): string {
    return STRENGTHS.find((s) => bits < s.below)?.label ?? "overkill";
}

/** `[#########-----------] 52 bits, good`: the bar is full at 128 bits. */
export function meter(bits: number, width = 20): string {
    const filled = Math.max(0, Math.min(width, Math.round((bits / 128) * width)));
    return `[${"#".repeat(filled)}${"-".repeat(width - filled)}] ${Math.round(bits)} bits, ${strength(bits)}`;
}
