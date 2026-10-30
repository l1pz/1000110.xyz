import { type Api, ApiError, NetworkError } from "./api";
import type { Tone } from "./jobs";

/** Shared by the three screens. */
export interface Ctx {
    api: Api;
    root: HTMLElement;
    /** Aborted when the visitor leaves the tool: every request and timer stops with it. */
    signal: AbortSignal;
    /** For a failed call: if it was about the login, takes over (goes to the login page, or says so) and returns true. */
    auth(error: unknown): boolean;
    /** The page title without the `(n running)` prefix. */
    baseTitle: string;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
}

/** A link inside the tool (`#sc2bp?j=...`): the hash router remounts the tool on every hash change. */
export function link(text: string, href: string, className = ""): HTMLAnchorElement {
    const a = h("a", className, text);
    a.href = href;
    return a;
}

export const jobLink = (id: string, review = false): string => `#sc2bp?j=${id}${review ? "&r=1" : ""}`;

/** An external link: new tab, no referrer. */
export function external(text: string, href: string): HTMLAnchorElement {
    const a = link(text, href);
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
}

export function tone(text: string, kind: Tone, className = "mark"): HTMLSpanElement {
    return h("span", `${className} ${kind}`, text);
}

/** What to tell the visitor about a failed call. */
export function describe(error: unknown): string {
    if (error instanceof NetworkError) return "cannot reach the server, trying again...";
    if (error instanceof ApiError) return error.message;
    return error instanceof Error ? error.message : "something went wrong";
}

/**
 * Runs `tick` now and again after the delay it returns, until `signal` aborts. It also runs at once when the tab
 * becomes visible again, because a hidden tab asks rarely. `tick` handles its own errors; a surprise retries in 10 s.
 */
export function startPolling(tick: () => Promise<number>, signal: AbortSignal): { now(): void } {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    const later = (ms: number) => {
        clearTimeout(timer);
        if (!signal.aborted) timer = setTimeout(() => void run(), ms);
    };
    const run = async () => {
        if (busy || signal.aborted) return;
        busy = true;
        try {
            later(await tick());
        } catch {
            later(10_000);
        } finally {
            busy = false;
        }
    };
    const visible = () => {
        if (!document.hidden) void run();
    };
    document.addEventListener("visibilitychange", visible);
    signal.addEventListener("abort", () => {
        clearTimeout(timer);
        document.removeEventListener("visibilitychange", visible);
    });
    void run();
    return {
        now() {
            clearTimeout(timer);
            void run();
        },
    };
}
