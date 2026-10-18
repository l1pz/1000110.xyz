import { escapeHtml } from "../html";
import { highlightJson } from "./json";
import { canonicalLang, GENERIC, type GenericLang, type Lang } from "./langs";

export { canonicalLang, GENERIC, type Lang } from "./langs";
export { splitHtmlLines } from "./tokens";

/** Highlighted HTML at once for the hand-written languages (json), `null` for those that need the lazy chunk. */
export function highlightNow(lang: Lang, text: string): string | null {
    return lang === "json" ? highlightJson(text) : null;
}

/**
 * Escaped HTML for `text` with highlight spans. `lang` is any name `canonicalLang` knows; an unknown one gives plain
 * escaped text. The generic languages load `highlight.js` on first use, so a page that never asks never pays for it.
 */
export async function highlight(lang: string, text: string): Promise<string> {
    const id = canonicalLang(lang);
    if (id === null) return escapeHtml(text);
    const now = highlightNow(id, text);
    if (now !== null) return now;
    if (!(GENERIC as readonly string[]).includes(id)) return escapeHtml(text);
    const { highlightGeneric } = await import("./generic");
    return highlightGeneric(id as GenericLang, text);
}
