import { describe, expect, it } from "vitest";
import { parseRoute, renderIndex, renderNotFound, renderTool, toolRows } from "../src/features/tools/page";
import type { ToolMeta } from "../src/features/tools/types";
import { assertShell } from "./helpers/shell";

const text: ToolMeta = { id: "case", title: "case converter", category: "text", summary: "UPPER & <lower>" };
const crypto: ToolMeta = { id: "hash", title: "hash", category: "crypto", summary: "sha", secret: "hi" };
const today = "2026-10-10";

describe("parseRoute", () => {
    it("is the list without a hash and a tool with one", () => {
        expect(parseRoute("")).toEqual({ view: "index" });
        expect(parseRoute("#")).toEqual({ view: "index" });
        expect(parseRoute("#case")).toEqual({ view: "tool", id: "case" });
        expect(parseRoute("#a%20b")).toEqual({ view: "tool", id: "a b" });
    });

    it("ignores the state after the id", () => {
        expect(parseRoute("#json?i=%7B%7D&m=minify")).toEqual({ view: "tool", id: "json" });
        expect(parseRoute("#?i=x")).toEqual({ view: "index" });
    });
});

describe("toolRows", () => {
    it("groups tools by category in the category order, one link per tool", () => {
        const html = toolRows([text, crypto]);
        expect(html.indexOf("crypto/")).toBeLessThan(html.indexOf("text/"));
        expect(html).toContain('<a class="row tool-row" href="#case"><span>case/</span>');
        expect(html).toContain('<a class="row tool-row" href="#hash">');
    });

    it("escapes the summary", () => {
        expect(toolRows([text])).toContain("UPPER &amp; &lt;lower&gt;");
    });

    it("says so when there are no tools", () => {
        expect(toolRows([])).toContain("(nothing here yet)");
    });
});

describe("tools pages", () => {
    it("the list goes through the page frame", () => {
        const html = renderIndex([text, crypto], today);
        assertShell(html);
        expect(html).toContain("ls tools/");
        expect(html).toContain("total 2");
    });

    it("a tool page has the frame, its title, the mount point and its own secret", () => {
        const html = renderTool(crypto, today);
        assertShell(html);
        expect(html).toContain('<h1 class="title">hash</h1>');
        expect(html).toContain('id="tool"');
        expect(html).toContain('class="secret dim"');
        expect(html).toContain('<a href="#">tools</a>');
    });

    it("an unknown tool is a shell error page with a way back", () => {
        const html = renderNotFound("<x>", today);
        assertShell(html);
        expect(html).toContain("bash: &lt;x&gt;: command not found");
        expect(html).toContain('<a href="#">cd ~/tools</a>');
    });
});
