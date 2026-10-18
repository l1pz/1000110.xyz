/** The key vocabulary every page shares (DESIGN.md 8.4). Pure `keyAction`, DOM wiring in `bindKeys`. */
import { getPage, type SitePage, windows } from "./site";
import { cycleTheme } from "./theme";

export type KeyAction =
    | { type: "window"; index: number }
    | { type: "scroll"; lines: number }
    | { type: "top" }
    | { type: "bottom" }
    | { type: "up" }
    | { type: "theme" };

/**
 * `1`-`9` go to that site window, `j`/`k` scroll, `g`/`G` jump to the top and bottom, `b` and Esc go up a level,
 * `t` switches to the next color theme.
 * `null` means "not ours, leave it to the browser" (space, PageUp, PageDown and the arrows already scroll).
 */
export function keyAction(key: string, windowCount: number): KeyAction | null {
    if (/^[1-9]$/.test(key) && Number(key) <= windowCount) return { type: "window", index: Number(key) - 1 };
    if (key === "j") return { type: "scroll", lines: 3 };
    if (key === "k") return { type: "scroll", lines: -3 };
    if (key === "g") return { type: "top" };
    if (key === "G") return { type: "bottom" };
    if (key === "b" || key === "Escape") return { type: "up" };
    if (key === "t") return { type: "theme" };
    return null;
}

/** Where "up" goes by default: the page's parent, or home. `null` on the home page itself. */
export function upPath(page: SitePage): string | null {
    if (page.parent) return getPage(page.parent).path;
    return page.id === "home" ? null : "/";
}

/** Listens for the shared keys. `up` overrides what "up" does (a blog post goes back to the list). */
export function bindKeys(page: SitePage, up?: () => void): void {
    document.addEventListener("keydown", (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.target instanceof HTMLElement && /^(input|textarea|select)$/i.test(e.target.tagName)) return;
        const all = windows();
        const action = keyAction(e.key, all.length);
        if (!action) return;
        e.preventDefault();
        if (action.type === "window") location.href = all[action.index].path;
        else if (action.type === "scroll") {
            const line = Number.parseFloat(getComputedStyle(document.body).lineHeight) || 20;
            window.scrollBy({ top: action.lines * line });
        } else if (action.type === "top") window.scrollTo(0, 0);
        else if (action.type === "bottom") window.scrollTo(0, document.documentElement.scrollHeight);
        else if (action.type === "theme") cycleTheme();
        else if (up) up();
        else {
            const path = upPath(page);
            if (path) location.href = path;
        }
    });
}
