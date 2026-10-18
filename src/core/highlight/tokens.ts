import { escapeHtml } from "../html";

/** Wraps `text` (escaped) in a token span. Classes are styled in `styles/highlight.css` from theme variables. */
export const token = (cls: string, text: string) => `<span class="${cls}">${escapeHtml(text)}</span>`;

const TAG = /<span class="[^"]*">|<\/span>/g;

/**
 * Splits highlighted HTML (only `<span class="...">` tags, as `highlight.js` and our tokenizers produce) at newlines,
 * closing the open spans at the end of each line and reopening them on the next, so every line stands alone.
 */
export function splitHtmlLines(html: string): string[] {
    const lines: string[] = [];
    const open: string[] = [];
    let line = "";
    let at = 0;
    const text = (chunk: string) => {
        const parts = chunk.split("\n");
        parts.forEach((part, i) => {
            if (i > 0) {
                lines.push(line + "</span>".repeat(open.length));
                line = open.join("");
            }
            line += part;
        });
    };
    for (const m of html.matchAll(TAG)) {
        text(html.slice(at, m.index));
        if (m[0] === "</span>") open.pop();
        else open.push(m[0]);
        line += m[0];
        at = (m.index ?? 0) + m[0].length;
    }
    text(html.slice(at));
    lines.push(line);
    return lines;
}
