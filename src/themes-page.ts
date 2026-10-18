import { escapeHtml } from "./core/html";
import { AUTO, THEMES } from "./core/theme";

/** The colors each row shows as blocks, in this order. */
const SWATCHES = ["fg", "yellow", "green", "aqua", "purple", "red", "gray"];

const LABEL_WIDTH = 15;

/**
 * The rows of `ls themes/`: `auto` first, then one row per theme. `choice` is the saved choice (a theme id or
 * `auto`), `resolvedId` the theme showing now. Each theme row carries its own `data-theme`, so its blocks and
 * background are drawn in that theme's colors whatever theme the page is in.
 */
export function themeRows(choice: string, resolvedId: string): string {
    const mark = (on: boolean) => (on ? "*" : " ");
    const resolved = THEMES.find((t) => t.id === resolvedId);
    const auto = `<button type="button" class="theme-row" data-choice="${AUTO}" aria-pressed="${choice === AUTO}">${mark(choice === AUTO)} ${AUTO.padEnd(LABEL_WIDTH)}<span class="dim">now: ${escapeHtml(resolved?.label ?? resolvedId)}</span></button>`;
    const rows = THEMES.map((t) => {
        const on = choice === t.id;
        const blocks = SWATCHES.map((c) => `<span class="sw-${c}">██</span>`).join("");
        return `<button type="button" class="theme-row" data-theme="${t.id}" data-choice="${t.id}" aria-pressed="${on}">${mark(on)} ${escapeHtml(t.label).padEnd(LABEL_WIDTH)}${blocks}</button>`;
    });
    return [auto, ...rows].join("\n");
}

/** The whole body of the theme page. */
export function themeBody(choice: string, resolvedId: string): string {
    return `<div id="theme-list">${themeRows(choice, resolvedId)}</div>\n<p class="dim">tap a row to switch. press t on any page to cycle. kept in this browser only; auto follows your system.</p>`;
}
