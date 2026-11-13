/**
 * What the tools that talk to the `sc2bp` service share (the conversion tool and the liked-music sync): errors, safe
 * links, one fetch wrapper that understands the tinyauth login, and the small text helpers behind both screens.
 * Pure: no DOM here, so it is tested directly.
 */
import { AuthError, browserLoginUrl, loginUrl } from "./auth";

/** How a thing looks on a row: running, fine, bad, a warning, or just idle. */
export type Tone = "run" | "ok" | "bad" | "warn" | "idle";

/** A Beatport track offered for a song. `genre` is what Beatport files it under. */
export interface Candidate {
    id: number;
    title: string;
    /** Beatport's mix name: "Original Mix", "Extended Mix", "Foo Remix". */
    mix: string;
    artists: string[];
    durationSec: number | null;
    score: number;
    genre?: string | null;
    subGenre?: string | null;
}

/** The server answered with an error; `message` is its explanation, `status` the HTTP status. */
export class ApiError extends Error {
    constructor(
        message: string,
        readonly status = 0,
    ) {
        super(message);
    }
}

/** The request never got an answer: offline, or the server is restarting. Worth trying again. */
export class NetworkError extends Error {
    constructor() {
        super("cannot reach the server");
    }
}

/** Only https links that stay on one of `hosts` are shown as links. */
export function safeLink(url: string | null, hosts: string[]): string | null {
    if (!url) return null;
    try {
        const u = new URL(url);
        const ok = hosts.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
        return u.protocol === "https:" && ok ? u.toString() : null;
    } catch {
        return null;
    }
}

export const beatportUrl = (url: string | null) => safeLink(url, ["beatport.com"]);
export const soundcloudUrl = (url: string | null) => safeLink(url, ["soundcloud.com"]);
export const youtubeUrl = (url: string | null) => safeLink(url, ["youtube.com", "youtu.be"]);

/** A track's own page, with the site's name for the "open on ..." link; null when the link is not one of the sources. */
export function sourcePage(url: string | null): { url: string; site: "soundcloud" | "youtube" } | null {
    const sc = soundcloudUrl(url);
    if (sc) return { url: sc, site: "soundcloud" };
    const yt = youtubeUrl(url);
    return yt ? { url: yt, site: "youtube" } : null;
}

export interface CallerOptions {
    /** The address to come back to after logging in. */
    returnTo: string;
    fetch?: typeof fetch;
    base: string;
}

export type Caller = <T>(method: string, path: string, signal?: AbortSignal, body?: unknown) => Promise<T>;

/** One JSON call to the service. Throws `AuthError` (not logged in), `ApiError` (it said no) or `NetworkError`. */
export function createCaller({
    returnTo,
    fetch: fetchImpl = (...args) => fetch(...args),
    base,
}: CallerOptions): Caller {
    return async function call<T>(method: string, path: string, signal?: AbortSignal, body?: unknown): Promise<T> {
        // "manual": a redirect to the login page is not followed (that page is on another origin, so the browser would
        // block it and the tool would call it a lost connection); it is read as "not logged in" below
        const init: RequestInit = { method, credentials: "same-origin", redirect: "manual", signal };
        if (body !== undefined) {
            init.headers = { "Content-Type": "application/json" };
            init.body = JSON.stringify(body);
        }
        let res: Response;
        try {
            res = await fetchImpl(`${base}${path}`, init);
        } catch (error) {
            if (signal?.aborted) throw error; // the caller left: not a network problem
            throw new NetworkError();
        }
        if (res.type === "opaqueredirect") throw new AuthError(browserLoginUrl(returnTo));
        if (res.status === 401 || res.status === 403) {
            throw new AuthError(loginUrl(res.headers.get("X-Tinyauth-Location"), returnTo));
        }
        if (!res.ok) {
            let message = `the server answered ${res.status}`;
            try {
                const detail = ((await res.json()) as { detail?: unknown }).detail;
                if (typeof detail === "string") message = detail;
            } catch {
                // no JSON body: keep the status line
            }
            throw new ApiError(message, res.status);
        }
        return (await res.json()) as T;
    };
}

/** Rounding down must not show 59% for 0.6 because of floating-point noise (0.03 + 0.27 + 0.3 is 0.6000000000000001). */
export const EPSILON = 1e-9;

/** `[█████░░░░░]`: filled by `ratio`; the blocks and shades are in the font. */
export function progressBar(ratio: number, width = 20): string {
    const filled = Math.max(0, Math.min(width, Math.floor(ratio * width + EPSILON)));
    return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
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

/** `6:05`, or `?` when the length is unknown. */
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
