import { describe, expect, it } from "vitest";
import { keyAction, upPath } from "../src/core/keys";
import { getPage } from "../src/core/site";
import {
    BAR_WIDTH,
    formatClock,
    metersHtml,
    progressBar,
    scrollFraction,
    themeLinkHtml,
    windowsHtml,
} from "../src/core/statusline";

describe("scrollFraction", () => {
    it("is 0 at the top, 1 at the bottom, and clamped", () => {
        expect(scrollFraction(0, 2000, 1000)).toBe(0);
        expect(scrollFraction(500, 2000, 1000)).toBe(0.5);
        expect(scrollFraction(1000, 2000, 1000)).toBe(1);
        expect(scrollFraction(5000, 2000, 1000)).toBe(1);
        expect(scrollFraction(-10, 2000, 1000)).toBe(0);
    });

    it("counts a page that fits the window as fully read", () => {
        expect(scrollFraction(0, 800, 1000)).toBe(1);
    });
});

describe("progressBar", () => {
    it("fills the bar in proportion, always the same width", () => {
        expect(progressBar(0)).toBe("░".repeat(BAR_WIDTH));
        expect(progressBar(0.5)).toBe(`${"█".repeat(10)}${"░".repeat(10)}`);
        expect(progressBar(1)).toBe("█".repeat(BAR_WIDTH));
        expect(progressBar(7)).toBe("█".repeat(BAR_WIDTH));
        expect(progressBar(-1)).toBe("░".repeat(BAR_WIDTH));
    });
});

describe("formatClock", () => {
    it("pads hours and minutes", () => {
        expect(formatClock(new Date(2026, 9, 9, 7, 5))).toBe("07:05");
        expect(formatClock(new Date(2026, 9, 9, 23, 41))).toBe("23:41");
    });
});

describe("windowsHtml", () => {
    it("lists the same site windows on every page, as links to the pages", () => {
        for (const id of ["home", "blog", "tools", "experiments", "fluiddynamics"]) {
            const html = windowsHtml(getPage(id));
            expect(html).toContain('href="/">1:home');
            expect(html).toContain('href="/blog/">2:blog');
            expect(html).toContain('href="/tools/">3:tools');
            expect(html).toContain('href="/experiments/">4:exp');
        }
    });

    it("marks only the current page's window", () => {
        const html = windowsHtml(getPage("blog"));
        expect(html).toContain('class="win active" href="/blog/">2:blog*</a>');
        expect(html.match(/active/g)).toHaveLength(1);
    });

    it("keeps the parent's window current on a child page", () => {
        expect(windowsHtml(getPage("fluiddynamics"))).toContain('class="win active" href="/experiments/">4:exp*</a>');
    });
});

describe("themeLinkHtml", () => {
    it("links to the theme page without a window number or the active mark", () => {
        const html = themeLinkHtml();
        expect(html).toContain('href="/theme/"');
        expect(html).not.toContain("active");
    });

    it("the theme page keeps home's window current and has no window of its own", () => {
        expect(windowsHtml(getPage("theme"))).toContain('class="win active" href="/">1:home*</a>');
        expect(windowsHtml(getPage("theme"))).not.toContain("theme");
    });
});

describe("metersHtml", () => {
    it("shows clock, bar and a fixed width percentage", () => {
        const html = metersHtml(new Date(2026, 9, 9, 23, 41), 0.42);
        expect(html).toContain('<span class="clock">23:41</span>');
        expect(html).toContain(`[${progressBar(0.42)}]`);
        expect(html).toContain('<span class="pct"> 42%</span>');
        expect(metersHtml(new Date(), 1)).toContain("100%");
    });
});

describe("keyAction", () => {
    it("jumps to a site window by number, only to windows that exist", () => {
        expect(keyAction("2", 3)).toEqual({ type: "window", index: 1 });
        expect(keyAction("4", 3)).toBeNull();
        expect(keyAction("0", 3)).toBeNull();
    });

    it("scrolls, jumps to the ends and goes up", () => {
        expect(keyAction("j", 3)).toEqual({ type: "scroll", lines: 3 });
        expect(keyAction("k", 3)).toEqual({ type: "scroll", lines: -3 });
        expect(keyAction("g", 3)).toEqual({ type: "top" });
        expect(keyAction("G", 3)).toEqual({ type: "bottom" });
        expect(keyAction("b", 3)).toEqual({ type: "up" });
        expect(keyAction("Escape", 3)).toEqual({ type: "up" });
    });

    it("t switches theme", () => {
        expect(keyAction("t", 3)).toEqual({ type: "theme" });
    });

    it("leaves other keys to the browser", () => {
        expect(keyAction(" ", 3)).toBeNull();
        expect(keyAction("ArrowDown", 3)).toBeNull();
        expect(keyAction("x", 3)).toBeNull();
    });
});

describe("upPath", () => {
    it("goes to the parent, or home, or nowhere on home", () => {
        expect(upPath(getPage("fluiddynamics"))).toBe("/experiments/");
        expect(upPath(getPage("blog"))).toBe("/");
        expect(upPath(getPage("home"))).toBeNull();
        expect(upPath(getPage("theme"))).toBe("/");
    });
});
