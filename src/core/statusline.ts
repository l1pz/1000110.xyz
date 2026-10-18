/**
 * The status line every page shares (DESIGN.md 8.3): the site windows on the left (`1:home 2:blog 3:exp`),
 * a clock and the scroll progress on the right. Pure helpers plus `mountStatusLine` for the DOM.
 */
import { escapeHtml } from "./html";
import { currentWindow, type SitePage, windows } from "./site";

export const BAR_WIDTH = 20;

/** How far down the page the reader is, 0 to 1. A page that fits the window counts as fully read. */
export function scrollFraction(scrollTop: number, scrollHeight: number, clientHeight: number): number {
    const max = scrollHeight - clientHeight;
    return max <= 0 ? 1 : Math.min(1, Math.max(0, scrollTop / max));
}

/** `████░░░░░░░░░░░░░░░░` for 0.2. */
export function progressBar(fraction: number, width = BAR_WIDTH): string {
    const filled = Math.round(Math.min(1, Math.max(0, fraction)) * width);
    return "█".repeat(filled) + "░".repeat(width - filled);
}

/** Local time as `HH:MM`. */
export function formatClock(date: Date): string {
    const two = (n: number) => String(n).padStart(2, "0");
    return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** `1:home* 2:blog 3:exp`, as links to the pages; the window of `page` carries a `*` and the `active` class. */
export function windowsHtml(page: SitePage): string {
    const current = currentWindow(page);
    return windows()
        .map((w, i) => {
            const active = w.id === current.id;
            return `<a class="win${active ? " active" : ""}" href="${escapeHtml(w.path)}">${i + 1}:${escapeHtml(w.window)}${active ? "*" : ""}</a>`;
        })
        .join(" ");
}

/**
 * The right side: `23:41 [████░░░░] 42%`. CSS hides the clock under 600px and the bar under 500px,
 * so a phone shows just the percentage.
 */
export function metersHtml(date: Date, fraction: number): string {
    const pct = String(Math.round(fraction * 100)).padStart(3);
    return `<span class="clock">${formatClock(date)}</span> <span class="bar">[${progressBar(fraction)}]</span> <span class="pct">${pct}%</span>`;
}

/**
 * Fills `el` with the status line for `page` and keeps it live (clock, scroll, resize).
 * Returns `update`, for pages that change their length without scrolling (e.g. after a route change).
 */
export function mountStatusLine(el: Element, page: SitePage): { update: () => void } {
    el.innerHTML = `<span id="windows">${windowsHtml(page)}</span><span id="meters"></span>`;
    const meters = el.querySelector("#meters");
    const update = () => {
        const root = document.documentElement;
        const fraction = scrollFraction(root.scrollTop, root.scrollHeight, root.clientHeight);
        if (meters) meters.innerHTML = metersHtml(new Date(), fraction);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    setInterval(update, 15_000);
    return { update };
}
