import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { pages } from "../src/core/site";
import { assertShell } from "./helpers/shell";

// Guards against "build passes but the deployed site is broken".
describe("production build", () => {
    beforeAll(() => {
        execSync("npx vite build", { stdio: "pipe" });
    }, 60_000);

    it("contains every page", () => {
        expect(existsSync("dist/index.html")).toBe(true);
        expect(existsSync("dist/blog/index.html")).toBe(true);
        expect(existsSync("dist/tools/index.html")).toBe(true);
        expect(existsSync("dist/theme/index.html")).toBe(true);
        expect(existsSync("dist/experiments/index.html")).toBe(true);
        expect(existsSync("dist/experiments/fluiddynamics/index.html")).toBe(true);
    });

    it("splits every tool into its own chunk, loaded when the tool is opened", () => {
        const html = readFileSync("dist/tools/index.html", "utf8");
        expect(html).toContain("/assets/");
        const chunks = readdirSync("dist/assets").filter((f) => f.endsWith(".js"));
        const tool = chunks
            .map((f) => readFileSync(`dist/assets/${f}`, "utf8"))
            .find((js) => js.includes("snake_case"));
        expect(tool, "a chunk with the case converter").toBeDefined();
        const entry = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1] ?? "";
        expect(readFileSync(`dist${entry}`, "utf8")).not.toContain("snake_case");
    });

    it("ships the RSS feed", () => {
        const feed = readFileSync("dist/feed.xml", "utf8");
        expect(feed).toContain('<?xml version="1.0"');
        expect(feed).toContain('<rss version="2.0"');
        expect(feed).toContain("<channel>");
    });

    it("ships the fonts the CSS asks for", () => {
        expect(existsSync("dist/fonts/stylesheet.css")).toBe(true);
        expect(existsSync("dist/fonts/DejaVuSansMono.woff2")).toBe(true);
    });

    it("gives every page in the site map the shell, a status line and the phone viewport", () => {
        for (const page of pages) {
            const html = readFileSync(`dist/${page.path.replace(/^\//, "")}index.html`, "utf8");
            expect(html, page.id).toContain('<body class="shell">');
            expect(html, page.id).toContain('id="status"');
            expect(html, page.id).toContain("viewport-fit=cover");
            expect(html, page.id).toContain("<noscript>");
        }
    });

    it("sets the saved theme before first paint, from a script in every page head", () => {
        for (const page of pages) {
            const html = readFileSync(`dist/${page.path.replace(/^\//, "")}index.html`, "utf8");
            const head = html.slice(0, html.indexOf("</head>"));
            expect(head, page.id).toMatch(/<script>[^<]*dataset\.theme[^<]*<\/script>/);
            // Ahead of the stylesheet, so the attribute is set before the first paint.
            expect(head.indexOf("dataset.theme"), page.id).toBeLessThan(head.indexOf("stylesheet"));
        }
    });

    it("generates the <noscript> home page from the same code as the JS page", () => {
        const html = readFileSync("dist/index.html", "utf8");
        const noscript = html.slice(html.indexOf("<noscript>"), html.indexOf("</noscript>"));
        expect(noscript).not.toContain("noscript-home"); // placeholder was replaced
        assertShell(noscript);
        for (const part of ["whoami", "cat portrait.txt", "ls ~/blog", "cat contact.txt"]) {
            expect(noscript).toContain(part);
        }
        expect(noscript).toContain('<a href="mailto:mmateka89@gmail.com">');
        expect(noscript).toContain('class="secret dim"');
    });
}, 60_000);
