export type State = "queued" | "running" | "paused" | "failed" | "cancelled" | "done";
export type Phase = "listing" | "reading" | "matching" | "creating" | "finished";
export type Filter = "unmatched" | "maybe" | "none" | "error" | "unreadable" | "picked" | "all";

export interface Counts {
    match: number;
    maybe: number;
    none: number;
    /** Tracks whose Beatport search failed (a retry tries them again). */
    error: number;
    unreadable: number;
    picked: number;
    added: number;
}

/** One conversion, as the server reports it (seconds are Unix time). */
export interface Job {
    id: string;
    name: string;
    url: string;
    state: State;
    phase: Phase;
    created: number;
    updated: number;
    total: number;
    progress: { phase: Phase; done: number; total: number };
    counts: Counts;
    /** Tracks nothing was picked for: what the review shows by default. */
    needsReview: number;
    /** Picked but not yet in the Beatport playlist. */
    pendingPicks: number;
    waiting: { until: number; reason: string } | null;
    error: { message: string; phase: Phase } | null;
    playlist: { id: number; url: string; name: string } | null;
}

export interface Candidate {
    id: number;
    title: string;
    /** Beatport's mix name: "Original Mix", "Extended Mix", "Foo Remix". */
    mix: string;
    artists: string[];
    durationSec: number | null;
    score: number;
}

export interface Track {
    index: number;
    url: string;
    label: string;
    title: string;
    uploader: string;
    durationSec: number | null;
    state: "new" | "blank" | "read" | "matched" | "unreadable" | "error";
    verdict: "match" | "maybe" | "none" | null;
    /** The Beatport track id that is (or will be) in the playlist. */
    picked: number | null;
    added: boolean;
    error: string | null;
    /** The search text used (editable for a search by hand). */
    query: string;
    candidates: Candidate[];
}

export interface TrackPage {
    total: number;
    tracks: Track[];
}

/** What the server offers (see `sc2bp/app.py`). Every call may throw `AuthError`, `ApiError` or `NetworkError`. */
export interface Api {
    /** Resolves when the visitor is logged in. */
    me(signal?: AbortSignal): Promise<void>;
    /** Starts a conversion; a link already being converted gives that job back with `created: false`. */
    start(url: string, name: string, signal?: AbortSignal): Promise<{ job: Job; created: boolean }>;
    list(signal?: AbortSignal): Promise<Job[]>;
    get(id: string, signal?: AbortSignal): Promise<Job>;
    tracks(id: string, filter: Filter, offset: number, limit: number, signal?: AbortSignal): Promise<TrackPage>;
    cancel(id: string, signal?: AbortSignal): Promise<Job>;
    /** Carries on a failed, paused or cancelled job; on a finished one, retries the tracks that hit an error. */
    retry(id: string, signal?: AbortSignal): Promise<Job>;
    /** Adds the tracks picked since the playlist was made. */
    apply(id: string, signal?: AbortSignal): Promise<Job>;
    remove(id: string, signal?: AbortSignal): Promise<void>;
    /** Picks one of a track's suggestions, or undoes the pick (`null`). */
    pick(id: string, index: number, candidateId: number | null, signal?: AbortSignal): Promise<Track>;
    /** Searches Beatport by hand for one track. */
    search(id: string, index: number, query: string, signal?: AbortSignal): Promise<Track>;
}

/** The server refused: not logged in. `loginUrl` is where to go, when the server said. */
export class AuthError extends Error {
    constructor(readonly loginUrl: string | null) {
        super("not logged in");
    }
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

/**
 * tinyauth answers a browser (by its User-Agent) with a `302` to its login page instead, and a script cannot read where
 * it points. So the address is built here: tinyauth lives on `auth.` next to the site. `null` away from a real site.
 */
export function browserLoginUrl(returnTo: string): string | null {
    try {
        const site = new URL(returnTo);
        if (site.protocol !== "https:") return null;
        const url = new URL(`https://auth.${site.hostname.replace(/^www\./, "")}/login`);
        url.searchParams.set("login_for", "app");
        url.searchParams.set("redirect_uri", returnTo);
        return url.toString();
    } catch {
        return null;
    }
}

/**
 * tinyauth answers an unauthenticated script call with `401` and its login address in `X-Tinyauth-Location`, whose
 * `redirect_uri` points at the API call. Points it back at `returnTo` (this tool) instead; `null` for anything odd.
 */
export function loginUrl(header: string | null, returnTo: string): string | null {
    if (!header) return null;
    try {
        const url = new URL(header);
        if (url.protocol !== "https:" && url.protocol !== "http:") return null;
        if (url.searchParams.has("redirect_uri")) url.searchParams.set("redirect_uri", returnTo);
        return url.toString();
    } catch {
        return null;
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

export interface RealApiOptions {
    /** The address to come back to after logging in. */
    returnTo: string;
    fetch?: typeof fetch;
    base?: string;
}

export function realApi({
    returnTo,
    fetch: fetchImpl = (...args) => fetch(...args),
    base = "/api/sc2bp",
}: RealApiOptions): Api {
    async function call<T>(method: string, path: string, signal?: AbortSignal, body?: unknown): Promise<T> {
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
    }

    const job = (id: string) => `/jobs/${encodeURIComponent(id)}`;
    const track = (id: string, index: number) => `${job(id)}/tracks/${index}`;

    return {
        async me(signal) {
            await call("GET", "/me", signal);
        },
        start: (url, name, signal) => call("POST", "/jobs", signal, { url, name }),
        async list(signal) {
            return (await call<{ jobs: Job[] }>("GET", "/jobs", signal)).jobs;
        },
        async get(id, signal) {
            return (await call<{ job: Job }>("GET", job(id), signal)).job;
        },
        tracks: (id, filter, offset, limit, signal) =>
            call("GET", `${job(id)}/tracks?filter=${filter}&offset=${offset}&limit=${limit}`, signal),
        async cancel(id, signal) {
            return (await call<{ job: Job }>("POST", `${job(id)}/cancel`, signal, {})).job;
        },
        async retry(id, signal) {
            return (await call<{ job: Job }>("POST", `${job(id)}/retry`, signal, {})).job;
        },
        async apply(id, signal) {
            return (await call<{ job: Job }>("POST", `${job(id)}/apply`, signal, {})).job;
        },
        async remove(id, signal) {
            await call("DELETE", job(id), signal);
        },
        async pick(id, index, candidateId, signal) {
            return (await call<{ track: Track }>("POST", `${track(id, index)}/pick`, signal, { id: candidateId }))
                .track;
        },
        async search(id, index, query, signal) {
            return (await call<{ track: Track }>("POST", `${track(id, index)}/search`, signal, { query })).track;
        },
    };
}
