import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalLang, GENERIC, highlight, highlightNow, splitHtmlLines } from "../src/core/highlight";
import { highlightJson } from "../src/core/highlight/json";
import { colorBox, readBox } from "../src/features/blog/code";
import { renderMarkdown } from "../src/features/blog/markdown";
import { highlightDiff } from "../src/features/tools/tools/diff/highlight";
import { explain } from "../src/features/tools/tools/regex/explain";
import { highlightRegex } from "../src/features/tools/tools/regex/highlight";

/** The text a highlighted string shows: tags removed, entities decoded. */
const plain = (html: string) =>
    html
        .replace(/<[^>]*>/g, "")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&");

const SAMPLES: Record<string, string> = {
    javascript: 'const x = 1; // note\nfunction f(a) { return `a${a}` + "s"; }\n/* multi\nline */',
    typescript: "interface A { n: number }\nexport const f = (a: A): string => String(a.n);",
    css: "a:hover > .b { color: #fff; margin: 0 auto } /* c */",
    xml: '<div class="a">text &amp; <b>bold</b></div>\n<!-- c -->',
    markdown: "# Title\n\n- item with `code` and **bold**\n\n```js\nx\n```",
    bash: 'echo "hi $USER" | grep -v x # c\nif [ -f a ]; then ls; fi',
};

const inner = (pre: string) => pre.replace(/^<pre[^>]*>|<\/pre>$/g, "");

describe("canonicalLang", () => {
    it("maps names and aliases, and ignores unknown languages", () => {
        expect(canonicalLang("js")).toBe("javascript");
        expect(canonicalLang("TS")).toBe("typescript");
        expect(canonicalLang("html")).toBe("xml");
        expect(canonicalLang("sh")).toBe("bash");
        expect(canonicalLang("json")).toBe("json");
        expect(canonicalLang("")).toBeNull();
        expect(canonicalLang("brainfuck")).toBeNull();
    });
});

describe("highlightJson", () => {
    it("colors keys, strings, numbers, literals and punctuation", () => {
        const html = highlightJson('{"a": [1, -2.5e3, true, null, "s"]}');
        expect(html).toContain('<span class="tok-key">&quot;a&quot;</span>');
        expect(html).toContain('<span class="tok-str">&quot;s&quot;</span>');
        expect(html).toContain('<span class="tok-num">-2.5e3</span>');
        expect(html).toContain('<span class="tok-kw">true</span>');
        expect(html).toContain('<span class="tok-kw">null</span>');
        expect(html).toContain('<span class="tok-punct">{</span>');
    });

    it("never changes the text and never throws, even on broken or hostile input", () => {
        for (const text of [
            '{"a":',
            '"unterminated',
            "{,,}",
            "<script>alert(1)</script>",
            '{"k": "<b>&"}',
            "",
            "\n\n",
        ]) {
            expect(plain(highlightJson(text))).toBe(text);
        }
        expect(highlightJson("<img onerror=x>")).not.toContain("<img");
    });
});

describe("highlight", () => {
    it("is plain escaped text for an unknown language", async () => {
        expect(await highlight("klingon", "<b>&")).toBe("&lt;b&gt;&amp;");
    });

    it("answers json at once and the generic languages through the lazy chunk", async () => {
        expect(highlightNow("json", "1")).toBe('<span class="tok-num">1</span>');
        expect(highlightNow("javascript", "1")).toBeNull();
        expect(await highlight("js", "const a = 1")).toContain('<span class="hljs-keyword">const</span>');
    });

    for (const lang of GENERIC) {
        it(`${lang} keeps the text and adds spans`, async () => {
            const html = await highlight(lang, SAMPLES[lang]);
            expect(plain(html)).toBe(SAMPLES[lang]);
            expect(html).toContain("<span");
        });
    }

    it("escapes markup in code", async () => {
        const html = await highlight("xml", "<script>alert(1)</script>");
        expect(html).not.toContain("<script>");
    });
});

describe("splitHtmlLines", () => {
    it("closes and reopens spans at line breaks so every line stands alone", () => {
        expect(splitHtmlLines('a<span class="c">x\ny</span>z\nb')).toEqual([
            'a<span class="c">x</span>',
            '<span class="c">y</span>z',
            "b",
        ]);
    });

    it("handles nested spans and text without spans", () => {
        expect(splitHtmlLines('<span class="a"><span class="b">1\n2</span></span>')).toEqual([
            '<span class="a"><span class="b">1</span></span>',
            '<span class="a"><span class="b">2</span></span>',
        ]);
        expect(splitHtmlLines("one")).toEqual(["one"]);
        expect(splitHtmlLines("")).toEqual([""]);
    });

    it("keeps a multi-line comment colored on every line of a highlighted block", async () => {
        const lines = splitHtmlLines(await highlight("js", "/* a\nb\nc */"));
        expect(lines).toHaveLength(3);
        for (const line of lines) expect(line).toContain("hljs-comment");
    });
});

describe("highlightRegex", () => {
    it("covers the whole pattern, in order", () => {
        for (const p of ["(?<id>\\d+)-[a-z]{2,}|^x.*?$", "\\u{1F600}\\k<id>(?:a)", "(unclosed", "[abc", "", "a<b>&"]) {
            expect(plain(highlightRegex(p))).toBe(p);
            expect(
                explain(p)
                    .map((s) => s.token)
                    .join(""),
            ).toBe(p);
        }
    });

    it("colors groups, classes, escapes, quantifiers and anchors", () => {
        const html = highlightRegex("^(\\d+)[a-z]?");
        expect(html).toContain('<span class="tok-kw">^</span>');
        expect(html).toContain('<span class="tok-group">(</span>');
        expect(html).toContain('<span class="tok-esc">\\d</span>');
        expect(html).toContain('<span class="tok-quant">+</span>');
        expect(html).toContain('<span class="tok-class">[a-z]</span>');
    });
});

describe("highlightDiff", () => {
    it("marks added, removed and unchanged lines and escapes the text", () => {
        const html = highlightDiff([
            { kind: "same", text: "a" },
            { kind: "del", text: "<b>" },
            { kind: "add", text: "c" },
        ]);
        expect(html).toBe(
            '<span class="tok-same">  a</span>\n<span class="tok-del">- &lt;b&gt;</span>\n<span class="tok-add">+ c</span>\n',
        );
    });
});

describe("blog code blocks", () => {
    it("tags highlighted languages with data-lang and leaves others alone", () => {
        expect(renderMarkdown("```js\nlet a\n```")).toContain('<pre class="code" data-lang="javascript">');
        expect(renderMarkdown("```\nplain\n```")).toContain('<pre class="code">');
        expect(renderMarkdown("```text\nplain\n```")).not.toContain("data-lang");
    });

    it("colors a block without changing its text or width", async () => {
        const source = '```js\nconst a = "x";\n/* two\nlines */\n\tindented()\n```';
        const box = plain(inner(renderMarkdown(source)));
        const colored = await colorBox(box, "javascript");
        expect(plain(inner(colored))).toBe(box);
        expect(colored).toContain("hljs-keyword");
        expect(colored).toContain("data-colored");
        expect(readBox(box)).toHaveLength(4);
    });
});

describe("highlight.css", () => {
    const css = readFileSync("styles/highlight.css", "utf8");

    it("uses theme variables only", () => {
        expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(css).not.toMatch(/\brgba?\(/);
    });

    it("styles every token class the highlighters emit", () => {
        const sources = [
            "src/core/highlight/json.ts",
            "src/features/tools/tools/regex/highlight.ts",
            "src/features/tools/tools/diff/highlight.ts",
        ].map((f) => readFileSync(f, "utf8"));
        const used = new Set(sources.flatMap((s) => s.match(/tok-[a-z]+/g) ?? []));
        expect(used.size).toBeGreaterThan(8);
        for (const cls of used) expect(css, cls).toContain(`.${cls}`);
    });
});
