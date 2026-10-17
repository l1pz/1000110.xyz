export interface Counts {
    characters: number;
    noSpaces: number;
    words: number;
    lines: number;
    sentences: number;
    paragraphs: number;
    bytes: number;
}

/** Average adult reading and speaking speeds, words per minute. */
const READ_WPM = 230;
const SPEAK_WPM = 130;

/** Counts of `text`. Characters are Unicode code points, not UTF-16 units; empty text has zero lines and paragraphs. */
export function countText(text: string): Counts {
    const words = text.match(/\S+/g)?.length ?? 0;
    return {
        characters: [...text].length,
        noSpaces: [...text.replace(/\s/gu, "")].length,
        words,
        lines: text === "" ? 0 : text.split(/\r\n|\r|\n/).length,
        sentences: text.match(/[^.!?…\s][^.!?…]*[.!?…]*/g)?.length ?? 0,
        paragraphs: text.split(/(?:\r?\n){2,}/).filter((p) => p.trim()).length,
        bytes: new TextEncoder().encode(text).length,
    };
}

/** `"under 1 min"`, `"3 min"`, `"1 h 05 min"`. */
export function duration(words: number, wpm: number): string {
    const minutes = words / wpm;
    if (minutes < 1) return words === 0 ? "0 min" : "under 1 min";
    const total = Math.round(minutes);
    return total < 60 ? `${total} min` : `${Math.floor(total / 60)} h ${String(total % 60).padStart(2, "0")} min`;
}

/** The rows shown to the user: label and value. */
export function rows(text: string): [string, string][] {
    const c = countText(text);
    return [
        ["characters", String(c.characters)],
        ["no spaces", String(c.noSpaces)],
        ["words", String(c.words)],
        ["lines", String(c.lines)],
        ["sentences", String(c.sentences)],
        ["paragraphs", String(c.paragraphs)],
        ["bytes (utf-8)", String(c.bytes)],
        ["reading time", duration(c.words, READ_WPM)],
        ["speaking time", duration(c.words, SPEAK_WPM)],
    ];
}
