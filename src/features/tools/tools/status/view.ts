import { escapeHtml } from "../../../../core/html";
import { type Beat, lastBeats, type Monitor, monitorNow, type Now, type Overall, type Report } from "./parse";

export const BAR_LENGTH = 20;
const NAME_WIDTH = 14;

const GLYPH: Record<Now, string> = { up: "█", down: "▒", pending: "░", maintenance: "░", none: "·", stale: "·" };
/** Colors come from theme variables in `styles/tools.css` (`.st-*`). */
const CLASS: Record<Now, string> = {
    up: "st-up",
    down: "st-down",
    pending: "st-warn",
    maintenance: "st-warn",
    none: "dim",
    stale: "st-warn",
};

export const fitName = (name: string, width = NAME_WIDTH): string =>
    name.length <= width ? name.padEnd(width) : `${name.slice(0, width - 1)}…`;

export function uptimeText(uptime: number | null): string {
    if (uptime === null) return "--";
    const pct = uptime * 100;
    return pct >= 99.95 ? "100%" : `${pct.toFixed(1)}%`;
}

export const barText = (beats: Beat[]): string =>
    lastBeats(beats, BAR_LENGTH)
        .map((b) => GLYPH[b])
        .join("");

function barHtml(beats: Beat[]): string {
    // One span per run of equal beats keeps the markup small.
    const runs: { cls: string; text: string }[] = [];
    for (const b of lastBeats(beats, BAR_LENGTH)) {
        const cls = CLASS[b];
        const last = runs[runs.length - 1];
        if (last?.cls === cls) last.text += GLYPH[b];
        else runs.push({ cls, text: GLYPH[b] });
    }
    return runs.map((r) => `<span class="${r.cls}">${r.text}</span>`).join("");
}

/** One line: name (14), the bar (20), the 24 h uptime (5): 41 columns, plus ` stale` when the beats stopped. */
export function monitorRow(m: Monitor, now: number): string {
    const state = monitorNow(m, now);
    const name = `<span class="${state === "down" ? "st-down" : ""}">${escapeHtml(fitName(m.name))}</span>`;
    const stale = state === "stale" ? '<span class="st-warn"> stale</span>' : "";
    return `${name} ${barHtml(m.beats)} <span class="dim">${uptimeText(m.uptime).padStart(5)}</span>${stale}`;
}

export function bannerHtml(o: Overall): string {
    const cls = { ok: "st-up", warn: "st-warn", down: "st-down" }[o.kind];
    return `<p class="status-banner"><span class="${cls}">●</span> ${escapeHtml(o.text)}</p>`;
}

const pad = (n: number) => String(n).padStart(2, "0");
export const clock = (ms: number): string => {
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};

export function reportHtml(report: Report, o: Overall, now: number): string {
    const groups = report.groups
        .filter((g) => g.monitors.length > 0)
        .map(
            (g) =>
                `<p class="dim">${escapeHtml(g.name)}/</p>\n<pre class="status-rows">${g.monitors.map((m) => monitorRow(m, now)).join("\n")}</pre>`,
        );
    return [bannerHtml(o), ...groups, `<p class="dim">updated ${clock(now)}, refreshes every minute</p>`].join("\n");
}

/** Never stale numbers: when the data cannot be read, this is all there is. `lastOk` is when it last could. */
export function unavailableHtml(reason: string, lastOk: number | null): string {
    return [
        '<p class="status-banner"><span class="st-down">●</span> status unavailable</p>',
        `<p class="dim">${escapeHtml(reason)}</p>`,
        ...(lastOk === null ? [] : [`<p class="dim">last good reading at ${clock(lastOk)}</p>`]),
    ].join("\n");
}
