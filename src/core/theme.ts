/**
 * Color themes (DESIGN.md 2b). A theme is a `[data-theme="<id>"]` block in `styles/theme.css`; this module knows
 * which ones exist, which one is chosen (localStorage key `theme`, or `auto`) and puts it on `<html>`.
 * The pure parts come first and are tested without a DOM; the DOM parts are below.
 */

export interface ThemeInfo {
    id: string;
    label: string;
    /** Must match the `color-scheme` the CSS block gives (dark unless it says light). */
    scheme: "dark" | "light";
}

/** In the order the theme page and the `t` key list them. Every id needs a block in `styles/theme.css`. */
export const THEMES: ThemeInfo[] = [
    { id: "gruvbox-dark", label: "gruvbox dark", scheme: "dark" },
    { id: "gruvbox-light", label: "gruvbox light", scheme: "light" },
    { id: "amber", label: "amber crt", scheme: "dark" },
    { id: "phosphor", label: "green phosphor", scheme: "dark" },
    { id: "solarized-dark", label: "solarized dark", scheme: "dark" },
    { id: "nord", label: "nord", scheme: "dark" },
];

/** The choice that follows the system: gruvbox dark or light, whichever the OS prefers. */
export const AUTO = "auto";
export const STORAGE_KEY = "theme";
const DARK_DEFAULT = "gruvbox-dark";
const LIGHT_DEFAULT = "gruvbox-light";

export const isThemeId = (value: unknown): value is string => THEMES.some((t) => t.id === value);

/** A stored value as a choice: a known theme id, otherwise `auto` (nothing stored, or junk). */
export function readChoice(raw: string | null | undefined): string {
    return isThemeId(raw) ? raw : AUTO;
}

/** The theme a choice shows right now. */
export function resolveTheme(choice: string, prefersLight: boolean): ThemeInfo {
    const id = isThemeId(choice) ? choice : prefersLight ? LIGHT_DEFAULT : DARK_DEFAULT;
    return THEMES.find((t) => t.id === id) as ThemeInfo;
}

/** The theme after `id` in the list, wrapping around (the `t` key). */
export function nextTheme(id: string): ThemeInfo {
    const i = THEMES.findIndex((t) => t.id === id);
    return THEMES[(i + 1) % THEMES.length];
}

// DOM

// Kept in memory too, so a browser that blocks storage still changes theme for the visit.
let fallback = AUTO;

export function getChoice(): string {
    try {
        return readChoice(localStorage.getItem(STORAGE_KEY));
    } catch {
        return fallback;
    }
}

const prefersLight = () => typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches;

export const currentTheme = (): ThemeInfo => resolveTheme(getChoice(), prefersLight());

/** Phone browsers color their address bar from this tag. */
function syncThemeColor(): void {
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) {
        meta = document.createElement("meta");
        meta.name = "theme-color";
        document.head.append(meta);
    }
    meta.content = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
}

/** Puts the current theme on `<html>` and tells the page (`themechange` on document). */
export function applyTheme(): ThemeInfo {
    const theme = currentTheme();
    document.documentElement.dataset.theme = theme.id;
    syncThemeColor();
    document.dispatchEvent(new Event("themechange"));
    return theme;
}

/** Saves a theme id, or `auto`, and applies it. Anything else is ignored. */
export function setChoice(choice: string): void {
    if (choice !== AUTO && !isThemeId(choice)) return;
    fallback = choice;
    try {
        if (choice === AUTO) localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, choice);
    } catch {
        // storage blocked: the choice lives in `fallback` until the page closes
    }
    applyTheme();
}

/** The `t` key: the next theme in the list, saved as an explicit choice. */
export function cycleTheme(): void {
    setChoice(nextTheme(currentTheme().id).id);
}

/**
 * Applies the saved theme (the inline boot script already did, before first paint; this also sets the
 * address bar color) and follows changes made in another tab or by the system while the choice is `auto`.
 */
export function initTheme(): void {
    applyTheme();
    window.addEventListener("storage", (e) => {
        if (e.key === STORAGE_KEY || e.key === null) applyTheme();
    });
    if (typeof matchMedia === "function") {
        matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
            if (getChoice() === AUTO) applyTheme();
        });
    }
}
