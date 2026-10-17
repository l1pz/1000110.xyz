/** Secure randomness shared by the generator tools. Tests pass their own `RandomBytes` to get fixed output. */

export type RandomBytes = (count: number) => Uint8Array;

export const systemRandom: RandomBytes = (count) => crypto.getRandomValues(new Uint8Array(count));

/** Uniform integer in `[0, max)` by rejection sampling, so there is no modulo bias. `max` is 1 to 2^32. */
export function randomInt(max: number, rand: RandomBytes = systemRandom): number {
    if (!Number.isInteger(max) || max < 1 || max > 2 ** 32)
        throw new RangeError(`max must be an integer from 1 to 2^32, got ${max}`);
    const limit = Math.floor(2 ** 32 / max) * max;
    for (;;) {
        const b = rand(4);
        const n = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
        if (n < limit) return n % max;
    }
}

/** A random element of a non-empty list. */
export function pick<T>(items: readonly T[], rand: RandomBytes = systemRandom): T {
    return items[randomInt(items.length, rand)];
}

/** Fisher-Yates shuffle in place. */
export function shuffle<T>(items: T[], rand: RandomBytes = systemRandom): T[] {
    for (let i = items.length - 1; i > 0; i--) {
        const j = randomInt(i + 1, rand);
        [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
}
