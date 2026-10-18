import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
    AUTO,
    applyTheme,
    currentTheme,
    cycleTheme,
    getChoice,
    isThemeId,
    nextTheme,
    readChoice,
    resolveTheme,
    setChoice,
    THEMES,
} from "../src/core/theme";
import { contrast, parseColor, type Rgb } from "../src/features/tools/tools/color/color";

describe("choices", () => {
    it("reads a known id, and anything else as auto", () => {
        expect(readChoice("nord")).toBe("nord");
        expect(readChoice("auto")).toBe(AUTO);
        expect(readChoice(null)).toBe(AUTO);
        expect(readChoice(undefined)).toBe(AUTO);
        expect(readChoice("hotdog-stand")).toBe(AUTO);
    });

    it("auto follows the system between gruvbox light and dark", () => {
        expect(resolveTheme(AUTO, false).id).toBe("gruvbox-dark");
        expect(resolveTheme(AUTO, true).id).toBe("gruvbox-light");
    });

    it("an explicit theme ignores the system", () => {
        expect(resolveTheme("nord", true).id).toBe("nord");
        expect(resolveTheme("gruvbox-light", false).id).toBe("gruvbox-light");
    });

    it("cycles through every theme and wraps around", () => {
        let id = THEMES[0].id;
        const seen: string[] = [];
        for (let i = 0; i < THEMES.length; i++) {
            id = nextTheme(id).id;
            seen.push(id);
        }
        expect(new Set(seen).size).toBe(THEMES.length);
        expect(id).toBe(THEMES[0].id);
        expect(nextTheme("not-a-theme").id).toBe(THEMES[0].id);
    });

    it("has unique, well formed ids", () => {
        expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
        for (const t of THEMES) expect(t.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
        expect(isThemeId("amber")).toBe(true);
        expect(isThemeId("auto")).toBe(false);
    });
});

describe("theme.css", () => {
    const VARS = ["bg", "fg", "aqua", "green", "yellow", "purple", "red", "gray", "bg-soft"];
    const css = readFileSync("styles/theme.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const blocks = new Map<string, Map<string, string>>();
    const schemes = new Map<string, string>();

    beforeAll(() => {
        for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
            for (const [, id] of selector.matchAll(/\[data-theme="([a-z-]+)"\]/g)) {
                const vars = blocks.get(id) ?? new Map<string, string>();
                for (const [, name, value] of body.matchAll(/--([a-z-]+):\s*([^;]+);/g)) vars.set(name, value.trim());
                blocks.set(id, vars);
                const scheme = body.match(/color-scheme:\s*(\w+)/)?.[1];
                if (scheme) schemes.set(id, scheme);
            }
        }
    });

    it("has a block for every theme and none for an unknown one", () => {
        expect([...blocks.keys()].sort()).toEqual(THEMES.map((t) => t.id).sort());
    });

    it("defines all nine color variables in every theme, as hex", () => {
        for (const t of THEMES) {
            for (const name of VARS) expect(blocks.get(t.id)?.get(name), `${t.id} --${name}`).toMatch(/^#[0-9a-f]{6}$/);
        }
    });

    it("says light for light themes (native controls follow) and nothing for dark ones", () => {
        for (const t of THEMES) {
            if (t.scheme === "light") expect(schemes.get(t.id), t.id).toBe("light");
            else expect(schemes.get(t.id), t.id).toBeUndefined();
        }
    });

    it("keeps text readable in every theme", () => {
        const color = (id: string, name: string): Rgb => {
            const rgb = parseColor(blocks.get(id)?.get(name) ?? "");
            if (!rgb) throw new Error(`${id} --${name} is not a color`);
            return rgb;
        };
        for (const t of THEMES) {
            const c = (name: string) => color(t.id, name);
            expect(contrast(c("fg"), c("bg")), `${t.id} fg on bg`).toBeGreaterThanOrEqual(7);
            expect(contrast(c("fg"), c("bg-soft")), `${t.id} fg on bg-soft`).toBeGreaterThanOrEqual(4.5);
            // The status line is yellow on bg-soft, the active window bg on yellow.
            expect(contrast(c("yellow"), c("bg-soft")), `${t.id} yellow on bg-soft`).toBeGreaterThanOrEqual(4.5);
            for (const name of ["yellow", "aqua", "green", "purple"]) {
                expect(contrast(c(name), c("bg")), `${t.id} ${name} on bg`).toBeGreaterThanOrEqual(4.5);
            }
            // Dim text and errors: gruvbox dark, the original, sets the floor (gray 4.0).
            for (const name of ["gray", "red"]) {
                expect(contrast(c(name), c("bg")), `${t.id} ${name} on bg`).toBeGreaterThanOrEqual(3.5);
            }
        }
    });

    it("keeps raw colors in this file only", () => {
        for (const file of ["shell", "blog", "tools", "card", "experiment", "reset", "main"]) {
            const other = readFileSync(`styles/${file}.css`, "utf8");
            expect(other, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        }
    });
});

describe("boot script", () => {
    // Runs the real script against fake globals and compares it with theme.ts.
    const boot = async (stored: string | null | "throws", prefersLight: boolean): Promise<string | undefined> => {
        const file = "../plugins/theme-boot.js";
        const { bootScript } = await import(file);
        const doc = { documentElement: { dataset: {} as Record<string, string> } };
        const storage = {
            getItem: () => {
                if (stored === "throws") throw new Error("blocked");
                return stored;
            },
        };
        const media = () => ({ matches: prefersLight });
        new Function("localStorage", "matchMedia", "document", bootScript)(storage, media, doc);
        return doc.documentElement.dataset.theme;
    };

    it("picks the same theme as theme.ts", async () => {
        for (const stored of [null, "auto", "nord", "amber", "junk", "throws"] as const) {
            for (const light of [false, true]) {
                const choice = stored === "throws" ? AUTO : readChoice(stored);
                const expected = resolveTheme(choice, light).id;
                const got = await boot(stored, light);
                // An unknown id is passed through (no CSS block matches); theme.ts corrects it later.
                expect(got, `${stored} light=${light}`).toBe(stored === "junk" ? "junk" : expected);
            }
        }
    });
});

describe("saving the choice", () => {
    const html = { dataset: {} as Record<string, string> };

    const setup = (opts: { blocked?: boolean; light?: boolean } = {}) => {
        const store = new Map<string, string>();
        const guard = () => {
            if (opts.blocked) throw new Error("blocked");
        };
        vi.stubGlobal("localStorage", {
            getItem: (k: string) => {
                guard();
                return store.get(k) ?? null;
            },
            setItem: (k: string, v: string) => {
                guard();
                store.set(k, v);
            },
            removeItem: (k: string) => {
                guard();
                store.delete(k);
            },
        });
        vi.stubGlobal("matchMedia", () => ({ matches: opts.light ?? false }));
        vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => " #282828 " }));
        const doc = {
            documentElement: html,
            head: { append: vi.fn() },
            querySelector: () => null,
            createElement: () => ({}),
            dispatchEvent: vi.fn(),
        };
        vi.stubGlobal("document", doc);
        return { store, doc };
    };

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("starts on auto and follows the system", () => {
        setup({ light: true });
        expect(getChoice()).toBe(AUTO);
        expect(currentTheme().id).toBe("gruvbox-light");
    });

    it("stores an explicit theme, puts it on <html> and announces it", () => {
        const { store, doc } = setup();
        setChoice("nord");
        expect(store.get("theme")).toBe("nord");
        expect(html.dataset.theme).toBe("nord");
        expect(doc.dispatchEvent).toHaveBeenCalled();
        expect(getChoice()).toBe("nord");
    });

    it("auto removes the stored value", () => {
        const { store } = setup();
        setChoice("nord");
        setChoice(AUTO);
        expect(store.has("theme")).toBe(false);
    });

    it("ignores an unknown theme", () => {
        const { store } = setup();
        setChoice("hotdog-stand");
        expect(store.has("theme")).toBe(false);
        expect(getChoice()).toBe(AUTO);
    });

    it("cycles from the theme showing now, and leaves auto", () => {
        const { store } = setup({ light: true });
        cycleTheme(); // showing gruvbox light, so the next one is amber
        expect(store.get("theme")).toBe("amber");
        expect(html.dataset.theme).toBe("amber");
    });

    it("still switches for the visit when storage is blocked", () => {
        setup({ blocked: true });
        expect(() => setChoice("phosphor")).not.toThrow();
        expect(getChoice()).toBe("phosphor");
        expect(applyTheme().id).toBe("phosphor");
    });
});
