import { normalize, type ParsedTrack } from "./parse";

/** A Beatport search result, reduced to what matching needs. */
export interface Candidate {
    id: number;
    title: string;
    /** Beatport's mix name: "Original Mix", "Extended Mix", "Foo Remix". */
    mix: string;
    artists: string[];
    durationSec: number | null;
}

export type Verdict = "match" | "maybe" | "none";

export interface Scored {
    candidate: Candidate;
    score: number;
    parts: { title: number; artist: number; mix: number; duration: number };
}

export interface MatchResult {
    verdict: Verdict;
    /** Best first, at most `KEEP` candidates. */
    ranked: Scored[];
}

const KEEP = 5;

/** Dice coefficient of character pairs: 1 for equal text, 0 for nothing in common. */
export function similarity(a: string, b: string): number {
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const pairs = new Map<string, number>();
    for (let i = 0; i < a.length - 1; i++) {
        const pair = a.slice(i, i + 2);
        pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
    }
    let shared = 0;
    for (let i = 0; i < b.length - 1; i++) {
        const pair = b.slice(i, i + 2);
        const left = pairs.get(pair) ?? 0;
        if (left > 0) {
            pairs.set(pair, left - 1);
            shared++;
        }
    }
    return (2 * shared) / (a.length + b.length - 2);
}

/** Share of the track's artists found in the candidate's artist list (as whole words). */
function artistScore(parsed: string[], candidate: string[]): number {
    if (parsed.length === 0) return 0;
    const haystack = ` ${normalize(candidate.join(" "))} `;
    const found = parsed.filter((name) => {
        const needle = normalize(name);
        return needle !== "" && haystack.includes(` ${needle} `);
    });
    return found.length / parsed.length;
}

const PLAIN_MIX = /^(?:original(?: mix)?|extended(?: mix)?|radio edit|radio mix)?$/;

/** A title with no mix is usually the original, so it fits "Original Mix" best and "Extended Mix" nearly as well. */
function mixScore(parsed: string, candidate: string): number {
    const want = normalize(parsed);
    const have = normalize(candidate);
    if (want === "") {
        if (have === "" || have === "original mix" || have === "original") return 1;
        return PLAIN_MIX.test(have) ? 0.8 : 0.3;
    }
    if (PLAIN_MIX.test(want) && PLAIN_MIX.test(have)) return 1;
    return similarity(want, have);
}

function durationScore(a: number | null, b: number | null): number {
    if (a === null || b === null) return 0.5;
    const diff = Math.abs(a - b);
    if (diff <= 2) return 1;
    if (diff <= 5) return 0.6;
    return diff <= 15 ? 0.2 : 0;
}

export function scoreCandidate(parsed: ParsedTrack, candidate: Candidate): Scored {
    const parts = {
        title: similarity(normalize(parsed.title), normalize(candidate.title)),
        artist: artistScore(parsed.artists, candidate.artists),
        mix: mixScore(parsed.mix, candidate.mix),
        duration: durationScore(parsed.durationSec, candidate.durationSec),
    };
    // a guessed artist is the uploader's name, which is often a label or a fan channel
    const w = parsed.artistGuessed
        ? { title: 0.6, artist: 0.1, mix: 0.2, duration: 0.1 }
        : { title: 0.45, artist: 0.25, mix: 0.2, duration: 0.1 };
    const score = parts.title * w.title + parts.artist * w.artist + parts.mix * w.mix + parts.duration * w.duration;
    return { candidate, score, parts };
}

/** Ranks Beatport results for one SoundCloud track and judges the best one. */
export function matchTrack(parsed: ParsedTrack, candidates: Candidate[]): MatchResult {
    const ranked = candidates
        .map((candidate) => scoreCandidate(parsed, candidate))
        .sort((a, b) => b.score - a.score)
        .slice(0, KEEP);
    const best = ranked[0];
    if (!best) return { verdict: "none", ranked };
    const { title, artist, mix } = best.parts;
    if (best.score >= 0.85 && title >= 0.9 && mix >= 0.8 && (parsed.artistGuessed || artist >= 0.5)) {
        return { verdict: "match", ranked };
    }
    return { verdict: best.score >= 0.55 && title >= 0.6 ? "maybe" : "none", ranked };
}
