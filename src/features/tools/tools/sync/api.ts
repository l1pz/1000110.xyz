import { AuthError, browserLoginUrl, loginUrl } from "../../auth";
import {
    ApiError,
    beatportUrl,
    type Candidate,
    createCaller,
    NetworkError,
    sourcePage,
    type Tone,
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
    sourcePage,
    type Tone,
    youtubeUrl,
};

export type RunState = "queued" | "running" | "awaiting" | "done" | "failed" | "cancelled";
export type RunPhase = "youtube" | "beatport" | "plan" | "match" | "file" | "finished";
export type InboxFilter = "review" | "notfound" | "unavailable" | "skipped" | "gone";
export type HealthStatus = "ok" | "unconfigured" | "needs-cookies" | "failed" | "stale" | "broken";

/** The most tracks per playlist the server accepts, and the longest names. */
export const MAX_CAP = 2000;
export const MAX_NAME = 40;
export const MAX_GROUPS = 30;
/** The catch-all group's id: tracks whose genre no group lists go there. */
export const OTHER = "other";

export interface RunCounts {
    newLikes: number;
    searched: number;
    matched: number;
    added: number;
    unavailable: number;
    dismissed: number;
}

export interface Preview {
    groups: { id: string; name: string; add: number; newPlaylists: number }[];
    total: number;
    newPlaylists: number;
    review: number;
    notFound: number;
}

/** One sync run (seconds are Unix time). */
export interface Run {
    id: string;
    kind: "manual" | "auto";
    state: RunState;
    phase: RunPhase;
    created: number;
    updated: number;
    finished: number | null;
    counts: RunCounts;
    error: { message: string; phase: RunPhase; kind: string; retryable: boolean } | null;
    waiting: { until: number; reason: string } | null;
    confirmed: boolean;
    preview: Preview | null;
    progress: { done: number; total: number } | null;
}

export interface Group {
    id: string;
    name: string;
    genres: string[];
}

export interface Nightly {
    enabled: boolean;
    hour: number;
    minute: number;
    tz: string;
}

export interface Config {
    source: string;
    prefix: string;
    cap: number;
    nightly: Nightly;
    groups: Group[];
    otherName: string;
}

export interface Health {
    ok: boolean;
    configured: boolean;
    status: HealthStatus;
    message: string;
}

export interface Counts {
    liked: number;
    onBeatport: number;
    review: number;
    notFound: number;
    unavailable: number;
    skipped: number;
    unreadable: number;
    dismissed: number;
    unliked: number;
    gone: number;
    needYou: number;
}

export interface PlaylistRef {
    id: number;
    name: string;
    url: string;
    count: number;
    gone: boolean;
}

export interface GroupStatus {
    id: string;
    name: string;
    tracks: number;
    playlists: PlaylistRef[];
}

/** Everything the home page shows. */
export interface Status {
    config: Config;
    health: Health;
    run: Run | null;
    counts: Counts;
    groups: GroupStatus[];
    /** Genres no group lists yet, with how many songs have each: they land in the catch-all group. */
    otherGenres: Record<string, number>;
    lastSuccess: number | null;
    nextAuto: number | null;
    confirmedOnce: boolean;
}

/** One liked song in the inbox. */
export interface Row {
    id: string;
    url: string;
    label: string;
    title: string;
    uploader: string;
    durationSec: number | null;
    status: "new" | "matched" | "review" | "notfound" | "unavailable" | "skipped" | "unreadable";
    verdict: "match" | "maybe" | "none" | null;
    picked: number | null;
    genre: string | null;
    group: string;
    groupOverride: string | null;
    filed: boolean;
    dismissed: boolean;
    query: string;
    candidates: Candidate[];
    error: string | null;
    checks: { n: number; next: number } | null;
}

/** A playlist the sync made that is no longer on Beatport. */
export interface GonePlaylist {
    group: string;
    id: number;
    name: string;
    tracks: number;
}

export interface InboxPage {
    total: number;
    videos: Row[];
    playlists: GonePlaylist[];
}

/** What can be changed in the settings; only the fields that changed are sent. */
export type ConfigPatch = Partial<Omit<Config, "nightly">> & { nightly?: Partial<Nightly> };

/** What the server offers (see `sc2bp/sync_routes.py`). Every call may throw `AuthError`, `ApiError` or `NetworkError`. */
export interface Api {
    /** Resolves when the visitor is logged in. */
    me(signal?: AbortSignal): Promise<void>;
    status(signal?: AbortSignal): Promise<Status>;
    /** Starts a sync; one already going is returned with `created: false`. */
    start(signal?: AbortSignal): Promise<{ run: Run; created: boolean }>;
    /** The first run waits for this after showing its preview. */
    confirm(runId: string, signal?: AbortSignal): Promise<Run>;
    cancel(runId: string, signal?: AbortSignal): Promise<Run>;
    runs(signal?: AbortSignal): Promise<Run[]>;
    inbox(filter: InboxFilter, offset: number, limit: number, signal?: AbortSignal): Promise<InboxPage>;
    /** Picks one of a song's suggestions, or undoes the pick (`null`). */
    pick(id: string, candidateId: number | null, signal?: AbortSignal): Promise<Row>;
    search(id: string, query: string, signal?: AbortSignal): Promise<Row>;
    skip(id: string, signal?: AbortSignal): Promise<Row>;
    restore(id: string, signal?: AbortSignal): Promise<Row>;
    /** Files this one song in another group (`null`: back to the genre's group). */
    setGroup(id: string, group: string | null, signal?: AbortSignal): Promise<Row>;
    saveConfig(patch: ConfigPatch, signal?: AbortSignal): Promise<Config>;
    importJob(jobId: string, signal?: AbortSignal): Promise<{ imported: number; total: number }>;
    /** What to do about a playlist that vanished: file its songs again in new playlists, or leave them out for good. */
    resolveGone(playlistId: number, action: "recreate" | "forget", signal?: AbortSignal): Promise<void>;
}

export interface RealApiOptions {
    /** The address to come back to after logging in. */
    returnTo: string;
    fetch?: typeof fetch;
    base?: string;
}

export function realApi({ returnTo, fetch: fetchImpl, base = "/api/sc2bp/sync" }: RealApiOptions): Api {
    const call = createCaller({ returnTo, fetch: fetchImpl, base });
    const video = (id: string) => `/videos/${encodeURIComponent(id)}`;
    const run = (id: string) => `/run/${encodeURIComponent(id)}`;
    return {
        async me(signal) {
            await call("GET", "", signal); // not /health: that one answers 503 exactly when the page has to explain why
        },
        status: (signal) => call("GET", "", signal),
        start: (signal) => call("POST", "/run", signal, {}),
        async confirm(runId, signal) {
            return (await call<{ run: Run }>("POST", `${run(runId)}/confirm`, signal, {})).run;
        },
        async cancel(runId, signal) {
            return (await call<{ run: Run }>("POST", `${run(runId)}/cancel`, signal, {})).run;
        },
        async runs(signal) {
            return (await call<{ runs: Run[] }>("GET", "/runs", signal)).runs;
        },
        inbox: (filter, offset, limit, signal) =>
            call("GET", `/inbox?filter=${filter}&offset=${offset}&limit=${limit}`, signal),
        async pick(id, candidateId, signal) {
            return (await call<{ track: Row }>("POST", `${video(id)}/pick`, signal, { id: candidateId })).track;
        },
        async search(id, query, signal) {
            return (await call<{ track: Row }>("POST", `${video(id)}/search`, signal, { query })).track;
        },
        async skip(id, signal) {
            return (await call<{ track: Row }>("POST", `${video(id)}/skip`, signal, {})).track;
        },
        async restore(id, signal) {
            return (await call<{ track: Row }>("POST", `${video(id)}/restore`, signal, {})).track;
        },
        async setGroup(id, group, signal) {
            return (await call<{ track: Row }>("POST", `${video(id)}/group`, signal, { group })).track;
        },
        async saveConfig(patch, signal) {
            return (await call<{ config: Config }>("PUT", "/config", signal, patch)).config;
        },
        importJob: (jobId, signal) => call("POST", "/import-job", signal, { jobId }),
        async resolveGone(playlistId, action, signal) {
            await call("POST", "/gone", signal, { playlistId, action });
        },
    };
}
