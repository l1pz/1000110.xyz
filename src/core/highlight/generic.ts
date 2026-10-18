/** Imported only through a dynamic `import()` in `index.ts`: this is the lazy `highlight.js` chunk. */
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import markdown from "highlight.js/lib/languages/markdown";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import type { GenericLang } from "./langs";

const LANGUAGES = { bash, css, javascript, markdown, typescript, xml };
for (const [name, language] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, language);

/** Escaped HTML with `hljs-*` spans. */
export function highlightGeneric(lang: GenericLang, text: string): string {
    return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
}
