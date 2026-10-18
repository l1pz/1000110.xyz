import { canonicalLang } from "../../core/highlight/langs";
import { escapeHtml } from "../../core/html";

// Only these links become <a>; anything else (javascript:, data:, ...) stays plain text.
const SAFE_URL = /^(https?:\/\/|mailto:|\/|#)[^*]*$/;

const FENCE = /^```\s*(\S*)\s*$/;
const HEADING = /^(#{1,3})\s+(.*)$/;
const RULE = /^(-{3,}|\*{3,})\s*$/;
const QUOTE = /^>/;
const BULLET = /^[-*]\s+/;
const NUMBER = /^\d+\.\s+/;

const startsBlock = (line: string) =>
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    NUMBER.test(line);

function formatSpan(escaped: string): string {
    return escaped
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label: string, url: string) =>
            SAFE_URL.test(url) ? `<a href="${url}">${label}</a>` : match,
        )
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

/** Inline Markdown: `code`, **bold**, *italic*, [text](url). All text is escaped first. */
export function renderInline(text: string): string {
    return escapeHtml(text)
        .split(/(`[^`]+`)/)
        .map((part, i) => (i % 2 === 1 ? `<code>${part.slice(1, -1)}</code>` : formatSpan(part)))
        .join("");
}

/** One code line: its raw text (for the width) and its HTML (escaped, optionally colored). */
export interface BoxLine {
    raw: string;
    html: string;
}

/**
 * A code block drawn as a text box: `┌─ lang ──┐ │ code │ └────────┘`. A language that is highlighted adds
 * `data-lang`; the blog page colors those blocks later (see `highlightBlocks`), keeping the box as it is.
 */
export function codeBoxHtml(lines: BoxLine[], lang: string, colored = false): string {
    const rows = lines.length === 0 ? [{ raw: "", html: "" }] : lines;
    const label = lang ? ` ${lang} ` : "";
    const width = Math.max(label.length, ...rows.map((l) => l.raw.length));
    const top = escapeHtml(`┌${`─${label}`.padEnd(width + 2, "─")}┐`);
    const body = rows.map((l) => `│ ${l.html}${" ".repeat(width - l.raw.length)} │`);
    const bottom = `└${"─".repeat(width + 2)}┘`;
    const language = canonicalLang(lang);
    const attr = language ? ` data-lang="${language}"${colored ? ' data-colored=""' : ""}` : "";
    return `<pre class="code"${attr}>${[top, ...body, bottom].join("\n")}</pre>`;
}

function codeBox(code: string[], lang: string): string {
    const lines = code.map((l) => l.replace(/\t/g, "    "));
    return codeBoxHtml(
        lines.map((raw) => ({ raw, html: escapeHtml(raw) })),
        lang,
    );
}

/**
 * Markdown subset to HTML: # ## ### headings, paragraphs, - or 1. lists, > quotes, ``` code ```, --- rules,
 * and the inline forms of `renderInline`. Anything else is plain paragraph text.
 */
export function renderMarkdown(source: string): string {
    const lines = source.replace(/\r\n?/g, "\n").split("\n");
    const out: string[] = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (line.trim() === "") {
            i++;
            continue;
        }

        const fence = line.match(FENCE);
        if (fence) {
            const code: string[] = [];
            i++;
            while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++]);
            i++; // the closing fence (an unclosed block runs to the end)
            out.push(codeBox(code, fence[1]));
            continue;
        }

        const heading = line.match(HEADING);
        if (heading) {
            const level = heading[1].length;
            out.push(`<h${level}><span class="mark">${heading[1]}</span> ${renderInline(heading[2])}</h${level}>`);
            i++;
            continue;
        }

        if (RULE.test(line)) {
            out.push("<hr>");
            i++;
            continue;
        }

        if (QUOTE.test(line)) {
            const quoted: string[] = [];
            while (i < lines.length && QUOTE.test(lines[i])) quoted.push(lines[i++].replace(/^>\s?/, ""));
            out.push(`<blockquote>${renderInline(quoted.join(" "))}</blockquote>`);
            continue;
        }

        const ordered = NUMBER.test(line);
        const marker = ordered ? NUMBER : BULLET;
        if (ordered || BULLET.test(line)) {
            const items: string[] = [];
            while (i < lines.length) {
                if (marker.test(lines[i])) items.push(lines[i++].replace(marker, ""));
                else if (items.length > 0 && /^\s+\S/.test(lines[i]))
                    items[items.length - 1] += ` ${lines[i++].trim()}`;
                else break;
            }
            const tag = ordered ? "ol" : "ul";
            out.push(`<${tag}>${items.map((t) => `<li>${renderInline(t)}</li>`).join("")}</${tag}>`);
            continue;
        }

        const paragraph = [lines[i++]];
        while (i < lines.length && lines[i].trim() !== "" && !startsBlock(lines[i])) paragraph.push(lines[i++]);
        out.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
    }
    return out.join("\n");
}
