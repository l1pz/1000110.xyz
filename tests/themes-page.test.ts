import { describe, expect, it } from "vitest";
import { renderPage } from "../src/core/shell";
import { getPage } from "../src/core/site";
import { AUTO, THEMES } from "../src/core/theme";
import { themeBody, themeRows } from "../src/themes-page";
import { assertShell } from "./helpers/shell";

describe("theme rows", () => {
    it("lists auto and every theme, each theme row scoped to its own theme", () => {
        const html = themeRows(AUTO, "gruvbox-dark");
        expect(html).toContain('data-choice="auto"');
        for (const t of THEMES) expect(html, t.id).toContain(`data-theme="${t.id}" data-choice="${t.id}"`);
        expect(html.match(/<button /g)).toHaveLength(THEMES.length + 1);
    });

    it("marks only the saved choice", () => {
        const html = themeRows("nord", "nord");
        expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
        expect(html).toContain('data-choice="nord" aria-pressed="true">* nord');
        expect(html).toContain('data-choice="auto" aria-pressed="false">  auto');
    });

    it("marks auto, and says which theme it shows now", () => {
        const html = themeRows(AUTO, "gruvbox-light");
        expect(html).toContain('data-choice="auto" aria-pressed="true">* auto');
        expect(html).toContain("now: gruvbox light");
    });

    it("fits the 40 columns of a phone", () => {
        const lines = themeRows("nord", "nord")
            .replace(/<[^>]+>/g, "")
            .split("\n");
        for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(40);
    });
});

describe("theme page", () => {
    it("goes through the page frame like every other page", () => {
        assertShell(
            renderPage({
                page: getPage("theme"),
                command: "ls themes/",
                body: themeBody(AUTO, "gruvbox-dark"),
                date: "2026-10-18",
                secret: "pick a color, any color",
            }),
        );
    });
});
