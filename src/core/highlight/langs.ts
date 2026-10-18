/** Languages that go through `highlight.js` (a lazy chunk), by canonical id. */
export const GENERIC = ["javascript", "typescript", "css", "xml", "markdown", "bash"] as const;
export type GenericLang = (typeof GENERIC)[number];
export type Lang = GenericLang | "json";

const ALIASES: Record<string, Lang> = {
    json: "json",
    javascript: "javascript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    typescript: "typescript",
    ts: "typescript",
    tsx: "typescript",
    css: "css",
    xml: "xml",
    html: "xml",
    svg: "xml",
    markdown: "markdown",
    md: "markdown",
    bash: "bash",
    sh: "bash",
    shell: "bash",
    zsh: "bash",
};

/** The language id for a name as written after ``` (`js`, `html`, ...), or `null` when it is not highlighted. */
export function canonicalLang(name: string): Lang | null {
    return ALIASES[name.trim().toLowerCase()] ?? null;
}
