import { escapeHtml } from "../html";
import { token } from "./tokens";

// One alternative per kind of token; anything else (whitespace, stray characters) stays plain.
const PARTS = /("(?:\.|[^"\\n])*"?)(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b|([{}[\],:])/g;

/** Colors JSON text: keys, strings, numbers, literals, punctuation. Never throws, so broken JSON still colors. */
export function highlightJson(text: string): string {
    let out = "";
    let at = 0;
    for (const m of text.matchAll(PARTS)) {
        out += escapeHtml(text.slice(at, m.index));
        if (m[1] !== undefined) {
            out += token(m[2] ? "tok-key" : "tok-str", m[1]);
            if (m[2]) out += escapeHtml(m[2]);
        } else if (m[3] !== undefined) out += token("tok-num", m[3]);
        else if (m[4] !== undefined) out += token("tok-kw", m[4]);
        else out += token("tok-punct", m[5]);
        at = (m.index ?? 0) + m[0].length;
    }
    return out + escapeHtml(text.slice(at));
}
