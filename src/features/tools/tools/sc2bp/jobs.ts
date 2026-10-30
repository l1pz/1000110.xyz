import type { Candidate, Filter, Job, Phase, State } from "./api";

/** Pure decisions behind the screens: what a job row says, which buttons a job gets, how often to ask the server. */

export type Tone = "run" | "ok" | "bad" | "warn" | "idle";

/** Rounding down must not show 59% for 0.6 because of floating-point noise (0.03 + 0.27 + 0.3 is 0.6000000000000001). */
const EPSILON = 1e-9;

export const isActive = (state: State): boolean => state === "queued" || state === "running";

/** Where a job's progress bar stands, 0 to 1. The phases share the bar by how long they usually take. */
const WEIGHTS: Record<Exclude<Phase, "finished">, number> = {
    listing: 0.03,
    reading: 0.27,
    matching: 0.6,
    creating: 0.1,
};
const ORDER: Phase[] = ["listing", "reading", "matching", "creating", "finished"];

export function overall(job: Job): number {
    if (job.state === "done" || job.phase === "finished") return 1;
    const at = ORDER.indexOf(job.progress.phase);
    let sum = 0;
    for (const phase of ORDER.slice(0, at)) sum += WEIGHTS[phase as keyof typeof WEIGHTS];
    const { done, total } = job.progress;
    const weight = WEIGHTS[job.progress.phase as keyof typeof WEIGHTS] ?? 0;
    if (total > 0) sum += weight * Math.min(1, done / total);
    return Math.min(1, sum);
}

/** `[█████░░░░░]`: filled by `ratio`; the blocks and shades are in the font. */
export function progressBar(ratio: number, width = 20): string {
    const filled = Math.max(0, Math.min(width, Math.floor(ratio * width + EPSILON)));
    return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

export function barText(job: Job): string {
    return `${progressBar(overall(job))} ${Math.floor(overall(job) * 100 + EPSILON)}%`;
}

export function phaseText(job: Job): string {
    const { done, total } = job.progress;
    switch (job.progress.phase) {
        case "listing":
            return "reading the playlist";
        case "reading":
            return `reading tracks ${done}/${total}`;
        case "matching":
            return `matching on Beatport ${done}/${total}`;
        case "creating":
            return `adding to the playlist ${done}/${total}`;
        default:
            return "finishing";
    }
}

export function stateMark(state: State): { text: string; tone: Tone } {
    switch (state) {
        case "queued":
            return { text: "[..]", tone: "idle" };
        case "running":
            return { text: "[>>]", tone: "run" };
        case "paused":
            return { text: "[||]", tone: "warn" };
        case "failed":
            return { text: "[!!]", tone: "bad" };
        case "cancelled":
            return { text: "[--]", tone: "idle" };
        default:
            return { text: "[ok]", tone: "ok" };
    }
}

/** `45s`, `3m`, `1h 05m`. */
export function duration(seconds: number): string {
    const s = Math.max(0, Math.round(seconds));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export const ago = (then: number, now: number): string =>
    now - then < 10 ? "just now" : `${duration(now - then)} ago`;

/** The playlist link without the scheme, for a job that has no name yet. */
export function fallbackName(url: string): string {
    return url.replace(/^https?:\/\/(www\.|m\.)?/, "").replace(/\/$/, "") || "playlist";
}

export function waitingText(waiting: Job["waiting"], now: number): string | null {
    if (!waiting) return null;
    return `retrying in ${Math.max(0, Math.ceil(waiting.until - now))}s (${waiting.reason})`;
}

export interface RowModel {
    mark: { text: string; tone: Tone };
    name: string;
    info: string;
    /** The progress bar line, for a job that is still going. */
    bar: string | null;
}

export function rowModel(job: Job, now: number): RowModel {
    const name = job.name || fallbackName(job.url);
    const mark = stateMark(job.state);
    const { added } = job.counts;
    const reason = job.error?.message ?? "";
    switch (job.state) {
        case "queued":
            return { mark, name, info: `waiting in the queue · added ${ago(job.created, now)}`, bar: null };
        case "running":
            return {
                mark,
                name,
                info: `${waitingText(job.waiting, now) ?? phaseText(job)} · started ${ago(job.created, now)}`,
                bar: barText(job),
            };
        case "paused":
            return { mark, name, info: `paused: ${reason}`, bar: barText(job) };
        case "failed":
            return { mark, name, info: `stopped: ${reason}`, bar: null };
        case "cancelled":
            return { mark, name, info: `cancelled · ${added} added · ${ago(job.updated, now)}`, bar: null };
        default: {
            const review = job.needsReview > 0 ? ` · ${job.needsReview} to review` : "";
            return {
                mark,
                name,
                info: `${added} of ${job.total} added${review} · ${ago(job.updated, now)}`,
                bar: null,
            };
        }
    }
}

/** Running and waiting jobs first, then the ones that need the owner, then the rest; newest first inside each. */
export function sortJobs(jobs: Job[]): Job[] {
    const rank = (j: Job) => (isActive(j.state) ? 0 : j.state === "paused" || j.state === "failed" ? 1 : 2);
    return [...jobs].sort((a, b) => rank(a) - rank(b) || b.created - a.created);
}

/** The tab title: how many jobs are running, or a hint that one needs the owner. */
export function tabTitle(jobs: Job[], base: string): string {
    const running = jobs.filter((j) => isActive(j.state)).length;
    if (running > 0) return `(${running} running) ${base}`;
    if (jobs.some((j) => j.state === "paused" || j.state === "failed")) return `(needs you) ${base}`;
    return base;
}

/** How long to wait before asking again: often while something runs, rarely when the tab is hidden or all is quiet. */
export function pollDelay(jobs: Job[], hidden: boolean): number {
    const active = jobs.some((j) => isActive(j.state));
    if (hidden) return active ? 15_000 : 60_000;
    return active ? 3_000 : 20_000;
}

export type ActionId = "cancel" | "retry" | "review" | "apply" | "delete";

export interface Action {
    id: ActionId;
    label: string;
}

/** The buttons a job gets, in order. */
export function actionsFor(job: Job): Action[] {
    const { error } = job.counts;
    switch (job.state) {
        case "queued":
        case "running":
            return [{ id: "cancel", label: "cancel" }];
        case "paused":
            return [
                { id: "retry", label: "retry now" },
                { id: "delete", label: "delete" },
            ];
        case "failed":
            return [
                { id: "retry", label: "retry" },
                { id: "delete", label: "delete" },
            ];
        case "cancelled":
            return [
                { id: "retry", label: "resume" },
                { id: "delete", label: "delete" },
            ];
        default: {
            const actions: Action[] = [];
            if (job.pendingPicks > 0)
                actions.push({ id: "apply", label: `add ${job.pendingPicks} picked to the playlist` });
            if (error > 0) actions.push({ id: "retry", label: `retry ${error} that hit an error` });
            if (job.needsReview > 0) actions.push({ id: "review", label: `review ${job.needsReview} not matched` });
            actions.push({ id: "delete", label: "delete" });
            return actions;
        }
    }
}

export interface Notice {
    tone: Tone;
    text: string;
}

/** What to tell the owner about a job that stopped, and what to do. */
export function noticeFor(job: Job): Notice | null {
    const reason = job.error?.message ?? "";
    switch (job.state) {
        case "failed":
            return { tone: "bad", text: `stopped: ${reason}. This needs you: fix the cause, then retry.` };
        case "paused":
            return { tone: "warn", text: `paused: ${reason}. Nothing is lost; retry when you like.` };
        case "cancelled":
            return { tone: "idle", text: "cancelled. What was done is kept; resume carries on from there." };
        default:
            return null;
    }
}

export interface ResultModel {
    headline: string;
    /** What happened to the tracks that were not added; empty counts are left out. */
    lines: string[];
}

/** The summary of a finished job: how many are in the playlist and why the others are not. */
export function resultModel(job: Job): ResultModel {
    const { added, none, maybe, error, unreadable } = job.counts;
    const headline =
        added > 0 ? `${added} of ${job.total} tracks are in your Beatport playlist` : "nothing was added to Beatport";
    const lines = [
        [none, "not found on Beatport"],
        [maybe, "found, but not sure"],
        [error, "hit an error"],
        [unreadable, "could not be read (private or deleted)"],
    ]
        .filter(([n]) => (n as number) > 0)
        .map(([n, text]) => `${text}: ${n}`);
    return { headline, lines };
}

export const formatTime = (seconds: number | null): string => {
    if (seconds === null) return "?";
    const s = Math.round(seconds);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** `Title (Mix) · Artist, Artist · 6:05` for a suggestion button. */
export function candidateText(c: Candidate): string {
    const mix = c.mix ? ` (${c.mix})` : "";
    return `${c.title.trim()}${mix} · ${c.artists.join(", ")} · ${formatTime(c.durationSec)}`;
}

export interface ReviewTab {
    filter: Filter;
    label: string;
}

/** The review's tabs; empty ones are left out, except the one being looked at. */
export function reviewTabs(job: Job, current: Filter): ReviewTab[] {
    const { none, maybe, error, unreadable } = job.counts;
    const all: [Filter, string, number][] = [
        ["unmatched", "not matched", job.needsReview],
        ["maybe", "not sure", maybe],
        ["none", "not found", none],
        ["error", "errors", error],
        ["unreadable", "unreadable", unreadable],
    ];
    return all.filter(([f, , n]) => n > 0 || f === current).map(([filter, label]) => ({ filter, label }));
}
