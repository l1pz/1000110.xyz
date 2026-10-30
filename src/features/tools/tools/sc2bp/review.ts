import { type Candidate, type MatchResult, matchTrack } from "./match";
import { type ParsedTrack, parseTrack, type SoundCloudTrack } from "./parse";

/** One SoundCloud track, what Beatport offered for it, and which result the visitor wants (by Beatport id). */
export interface Row {
    source: SoundCloudTrack;
    parsed: ParsedTrack;
    result: MatchResult;
    picked: number | null;
}

/** Pairs each track with its Beatport results; a confident `match` is picked at once, a `maybe` waits for the visitor. */
export function buildRows(tracks: SoundCloudTrack[], found: Candidate[][]): Row[] {
    return tracks.map((source, i) => {
        const parsed = parseTrack(source);
        const result = matchTrack(parsed, found[i] ?? []);
        const picked = result.verdict === "match" ? result.ranked[0].candidate.id : null;
        return { source, parsed, result, picked };
    });
}

export interface Summary {
    match: number;
    maybe: number;
    none: number;
    /** Distinct Beatport tracks that would be added. */
    selected: number;
}

export function summary(rows: Row[]): Summary {
    const count = (verdict: string) => rows.filter((r) => r.result.verdict === verdict).length;
    return { match: count("match"), maybe: count("maybe"), none: count("none"), selected: selectedIds(rows).length };
}

/** The picked Beatport ids in playlist order; a track picked by two rows is added once. */
export function selectedIds(rows: Row[]): number[] {
    const seen = new Set<number>();
    for (const row of rows) if (row.picked !== null) seen.add(row.picked);
    return [...seen];
}

/** `Artist, Artist - Title (Mix)`, the way the row shows the SoundCloud track. */
export function label(parsed: ParsedTrack): string {
    const mix = parsed.mix ? ` (${parsed.mix})` : "";
    const artists = parsed.artists.join(", ");
    return `${artists ? `${artists} - ` : ""}${parsed.title}${mix}`;
}

/** The tracks nothing was picked for, one per line, for pasting somewhere else. */
export function missingText(rows: Row[]): string {
    return rows
        .filter((r) => r.picked === null)
        .map((r) => r.source.title)
        .join("\n");
}

/** `6:05`, or `?` when unknown. */
export function formatTime(seconds: number | null): string {
    if (seconds === null) return "?";
    const s = Math.round(seconds);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
