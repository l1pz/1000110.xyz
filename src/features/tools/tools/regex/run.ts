export const FLAGS = [
    { id: "g", label: "g all" },
    { id: "i", label: "i case" },
    { id: "m", label: "m lines" },
    { id: "s", label: "s dotall" },
    { id: "u", label: "u unicode" },
] as const;

export interface Match {
    index: number;
    text: string;
    /** Capture groups in order; `undefined` when the group did not take part. */
    groups: (string | undefined)[];
    named: Record<string, string | undefined>;
}

export interface Segment {
    text: string;
    /** Index into the matches when this part is matched text. */
    match?: number;
}

export class RegexError extends Error {}

/** Matches kept; more are counted but not listed, so a pattern like `.` on a long text stays responsive. */
export const MAX_MATCHES = 500;

/**
 * Runs `pattern` over `text`. Without the `g` flag only the first match is returned, as in `String.match`.
 * Throws `RegexError` for an invalid pattern or flags. `total` can exceed `matches.length` at `MAX_MATCHES`.
 */
export function runRegex(pattern: string, flags: string, text: string): { matches: Match[]; total: number } {
    if (pattern === "") return { matches: [], total: 0 };
    const all = flags.includes("g");
    let re: RegExp;
    try {
        re = new RegExp(pattern, all ? flags : `${flags}g`);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new RegexError(message.replace(/^Invalid regular expression: /, ""));
    }
    const matches: Match[] = [];
    let total = 0;
    for (const m of text.matchAll(re)) {
        total++;
        if (matches.length < MAX_MATCHES) {
            matches.push({ index: m.index ?? 0, text: m[0], groups: m.slice(1), named: { ...m.groups } });
        }
        if (!all) break;
    }
    return { matches, total };
}

/** Splits `text` into plain and matched parts for highlighting. Empty matches have nothing to show and are skipped. */
export function segments(text: string, matches: Match[]): Segment[] {
    const out: Segment[] = [];
    let at = 0;
    matches.forEach((m, i) => {
        if (m.text === "") return;
        if (m.index > at) out.push({ text: text.slice(at, m.index) });
        out.push({ text: m.text, match: i });
        at = m.index + m.text.length;
    });
    if (at < text.length) out.push({ text: text.slice(at) });
    return out;
}
