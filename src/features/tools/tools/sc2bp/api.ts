import { AuthError, browserLoginUrl, loginUrl } from "../../auth";
import {
    ApiError,
    beatportUrl,
    type Candidate,
    createCaller,
    NetworkError,
    safeLink,
    soundcloudUrl,
    sourcePage,
    youtubeUrl,
} from "../../backend";

export {
    ApiError,
    AuthError,
    beatportUrl,
    browserLoginUrl,
    type Candidate,
    loginUrl,
    NetworkError,
    safeLink,
    soundcloudUrl,
    sourcePage,
    youtubeUrl,
};

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
    /** Where the playlist came from; jobs saved before YouTube existed may leave it out. */
    source?: "soundcloud" | "youtube";
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
    /** The most tracks per Beatport playlist; 0 means everything goes into one. */
    split: number;
    /** The Beatport playlists made so far, in order (`Name #1`, `Name #2`, ...). */
    playlists: PlaylistRef[];
}

export interface PlaylistRef {
    id: number;
    url: string;
    name: string;
    /** Tracks in it now. */
    count: number;
}

/** The most tracks per playlist the server accepts. */
export const MAX_SPLIT = 2000;

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
    start(url: string, name: string, split: number, signal?: AbortSignal): Promise<{ job: Job; created: boolean }>;
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
    const call = createCaller({ returnTo, fetch: fetchImpl, base });

    const job = (id: string) => `/jobs/${encodeURIComponent(id)}`;
    const track = (id: string, index: number) => `${job(id)}/tracks/${index}`;

    return {
        async me(signal) {
            await call("GET", "/me", signal);
        },
        start: (url, name, split, signal) => call("POST", "/jobs", signal, { url, name, split }),
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
