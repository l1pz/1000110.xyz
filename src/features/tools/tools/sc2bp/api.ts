import type { Candidate } from "./match";
import type { ParsedTrack, SoundCloudTrack } from "./parse";

export interface PlaylistInfo {
    name: string;
    tracks: SoundCloudTrack[];
}

export interface Created {
    name: string;
    added: number;
    /** Where the new playlist lives on Beatport, when the server knows. */
    url: string | null;
}

/** What the server offers (see `sc2bp/app.py`). Every call may throw `AuthError` or `ApiError`. */
export interface Api {
    /** Resolves when the visitor is logged in. */
    me(signal?: AbortSignal): Promise<void>;
    playlist(url: string, signal?: AbortSignal): Promise<PlaylistInfo>;
    /** One list of candidates per query, in the same order. */
    search(queries: string[], signal?: AbortSignal): Promise<Candidate[][]>;
    create(name: string, ids: number[], signal?: AbortSignal): Promise<Created>;
}

/** The server refused: not logged in. `loginUrl` is where to go, when the server said. */
export class AuthError extends Error {
    constructor(readonly loginUrl: string | null) {
        super("not logged in");
    }
}

export class ApiError extends Error {}

/** Tracks per search request: small enough to stay well inside a proxy timeout. */
export const SEARCH_BATCH = 10;

export function chunk<T>(items: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
    return out;
}

/** The Beatport search text for a track: its artists and title; the mix is left to the scoring. */
export function searchQuery(track: ParsedTrack): string {
    return [...track.artists, track.title].join(" ").replace(/\s+/g, " ").trim();
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

/** Only links that stay on beatport.com are shown as links. */
export function beatportUrl(url: string | null): string | null {
    if (!url) return null;
    try {
        const u = new URL(url);
        return u.protocol === "https:" && (u.hostname === "beatport.com" || u.hostname.endsWith(".beatport.com"))
            ? u.toString()
            : null;
    } catch {
        return null;
    }
}

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
    async function call<T>(path: string, signal?: AbortSignal, body?: unknown): Promise<T> {
        const init: RequestInit = { credentials: "same-origin", signal };
        if (body !== undefined) {
            init.method = "POST";
            init.headers = { "Content-Type": "application/json" };
            init.body = JSON.stringify(body);
        }
        const res = await fetchImpl(`${base}${path}`, init);
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
            throw new ApiError(message);
        }
        return (await res.json()) as T;
    }

    return {
        async me(signal) {
            await call("/me", signal);
        },
        playlist: (url, signal) => call<PlaylistInfo>("/playlist", signal, { url }),
        async search(queries, signal) {
            const { results } = await call<{ results: Candidate[][] }>("/search", signal, { queries });
            if (!Array.isArray(results) || results.length !== queries.length) {
                throw new ApiError("the server returned the wrong number of search results");
            }
            return results;
        },
        create: (name, ids, signal) => call<Created>("/create", signal, { name, ids }),
    };
}
