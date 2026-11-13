/** A fake server for `npm run dev`: the same screens with believable data, nothing is stored anywhere. */
import { ApiError, type Candidate } from "../../backend";
import type {
    Api,
    Config,
    Counts,
    GonePlaylist,
    Group,
    GroupStatus,
    InboxFilter,
    Preview,
    Row,
    Run,
    RunPhase,
    Status,
} from "./api";

const now = () => Date.now() / 1000;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const GROUPS: Group[] = [
    {
        id: "techno",
        name: "Techno",
        genres: ["Techno (Peak Time / Driving)", "Techno (Raw / Deep / Hypnotic)", "Hard Techno"],
    },
    { id: "house-melodic", name: "House & Melodic", genres: ["House", "Tech House", "Melodic House & Techno"] },
    { id: "bass", name: "Drum & Bass and Bass", genres: ["Drum & Bass", "Dubstep"] },
];
const PHASES: [Exclude<RunPhase, "finished">, number][] = [
    ["youtube", 1.5],
    ["beatport", 2],
    ["plan", 1],
    ["match", 5],
    ["file", 4],
];

interface State {
    config: Config;
    rows: Map<string, Row>;
    run: { id: string; started: number; confirmed: boolean; cancelled: boolean; kind: "manual" | "auto" } | null;
    runs: Run[];
    confirmedOnce: boolean;
    gone: GonePlaylist[];
    lastSuccess: number | null;
}

function candidate(i: number, genre: string, score: number): Candidate {
    return {
        id: 9000 + i,
        title: `Song ${i}`,
        mix: "Original Mix",
        artists: [`Artist ${i}`],
        durationSec: 300 + i,
        score,
        genre,
    };
}

function makeRows(): Map<string, Row> {
    const rows = new Map<string, Row>();
    const base = (i: number, status: Row["status"]): Row => ({
        id: `demo${i}`,
        url: `https://music.youtube.com/watch?v=demo${i}`,
        label: `Artist ${i} - Song ${i}`,
        title: `Artist ${i} - Song ${i} (Official Video)`,
        uploader: `Artist ${i}`,
        durationSec: 300 + i,
        status,
        verdict: null,
        picked: null,
        genre: null,
        group: "other",
        groupOverride: null,
        filed: false,
        dismissed: false,
        query: `Artist ${i} Song ${i}`,
        candidates: [],
        error: null,
        checks: null,
    });
    for (let i = 0; i < 40; i++) {
        const r = base(i, "review");
        r.verdict = "maybe";
        r.candidates = [
            candidate(i, i % 2 ? "House" : "Hard Techno", 0.78),
            candidate(i + 100, "Techno (Peak Time / Driving)", 0.64),
        ];
        rows.set(r.id, r);
    }
    for (let i = 40; i < 70; i++) {
        const r = base(i, "notfound");
        r.verdict = "none";
        r.checks = { n: 1, next: now() + 9 * 86400 };
        rows.set(r.id, r);
    }
    for (let i = 70; i < 73; i++) {
        const r = base(i, "unavailable");
        r.picked = 9000 + i;
        r.genre = "House";
        r.group = "house-melodic";
        r.checks = { n: 1, next: now() + 20 * 86400 };
        rows.set(r.id, r);
    }
    return rows;
}

const state: State = {
    config: {
        source: "https://www.youtube.com/playlist?list=LM",
        prefix: "Liked",
        cap: 100,
        nightly: { enabled: false, hour: 4, minute: 30, tz: "Europe/Budapest" },
        groups: GROUPS.map((g) => ({ ...g, genres: [...g.genres] })),
        otherName: "Other",
    },
    rows: makeRows(),
    run: null,
    runs: [],
    confirmedOnce: false,
    gone: [{ group: "bass", id: 4242, name: "Liked - Drum & Bass and Bass #1", tracks: 41 }],
    lastSuccess: null,
};

const count = (status: Row["status"]) => [...state.rows.values()].filter((r) => r.status === status).length;

function preview(): Preview {
    return {
        groups: [
            { id: "techno", name: "Techno", add: 259, newPlaylists: 3 },
            { id: "house-melodic", name: "House & Melodic", add: 118, newPlaylists: 2 },
            { id: "bass", name: "Drum & Bass and Bass", add: 71, newPlaylists: 1 },
        ],
        total: 448,
        newPlaylists: 6,
        review: count("review"),
        notFound: count("notfound"),
    };
}

/** The fake run: phases by the clock, a stop at the preview on the first run, then filing, then done. */
function runView(): Run | null {
    const r = state.run;
    if (!r) return null;
    const e = now() - r.started;
    let phase: RunPhase = "finished";
    let left = e;
    let progress: Run["progress"] = null;
    for (const [name, secs] of PHASES) {
        if (left < secs) {
            phase = name;
            if (name === "match" || name === "file") progress = { done: Math.floor((left / secs) * 340), total: 340 };
            break;
        }
        left -= secs;
    }
    const matchEnd = PHASES.slice(0, 4).reduce((a, [, s]) => a + s, 0);
    const first = !state.confirmedOnce && !r.confirmed;
    const base = {
        id: r.id,
        kind: r.kind,
        created: r.started,
        updated: now(),
        counts: { newLikes: 0, searched: 340, matched: 300, added: 0, unavailable: 0, dismissed: 0 },
        error: null,
        waiting: null,
        confirmed: r.confirmed,
    };
    if (r.cancelled)
        return { ...base, state: "cancelled", phase, finished: r.started + e, preview: null, progress: null };
    if (first && e >= matchEnd)
        return { ...base, state: "awaiting", phase: "match", finished: null, preview: preview(), progress: null };
    if (phase === "finished") {
        if (!state.confirmedOnce) {
            state.confirmedOnce = true;
            state.lastSuccess = now();
        }
        const finished = {
            ...base,
            state: "done" as const,
            phase,
            finished: now(),
            preview: null,
            progress: null,
            counts: { ...base.counts, added: 448, unavailable: 23 },
        };
        if (!state.runs.some((x) => x.id === r.id)) state.runs.unshift(finished);
        return finished;
    }
    return { ...base, state: "running", phase, finished: null, preview: null, progress };
}

function groupsStatus(): GroupStatus[] {
    if (!state.confirmedOnce)
        return state.config.groups.map((g) => ({ id: g.id, name: g.name, tracks: 0, playlists: [] }));
    return [
        {
            id: "techno",
            name: "Techno",
            tracks: 259,
            playlists: [1, 2, 3].map((n) => ({
                id: n,
                name: `Liked - Techno #${n}`,
                url: `https://www.beatport.com/library/playlists/${n}`,
                count: n < 3 ? 100 : 59,
                gone: false,
            })),
        },
        {
            id: "house-melodic",
            name: "House & Melodic",
            tracks: 118,
            playlists: [4, 5].map((n) => ({
                id: n,
                name: `Liked - House & Melodic #${n - 3}`,
                url: `https://www.beatport.com/library/playlists/${n}`,
                count: n === 4 ? 100 : 18,
                gone: false,
            })),
        },
        {
            id: "bass",
            name: "Drum & Bass and Bass",
            tracks: 71,
            playlists: [
                {
                    id: 4242,
                    name: "Liked - Drum & Bass and Bass #1",
                    url: "https://www.beatport.com/library/playlists/4242",
                    count: 71,
                    gone: true,
                },
            ],
        },
    ];
}

function counts(): Counts {
    return {
        liked: 1530,
        onBeatport: state.confirmedOnce ? 448 : 0,
        review: count("review"),
        notFound: count("notfound"),
        unavailable: count("unavailable"),
        skipped: count("skipped"),
        unreadable: 18,
        dismissed: 0,
        unliked: 0,
        gone: state.gone.length,
        needYou: count("review") + state.gone.length,
    };
}

function status(): Status {
    const run = runView();
    return {
        config: state.config,
        health: state.confirmedOnce
            ? { ok: true, configured: true, status: "ok", message: "" }
            : { ok: true, configured: false, status: "unconfigured", message: "no sync has finished yet" },
        run,
        counts: counts(),
        groups: groupsStatus(),
        otherGenres: { Polka: 3, "Latin Pop": 1 },
        lastSuccess: state.lastSuccess,
        nextAuto: state.config.nightly.enabled && state.confirmedOnce ? now() + 14 * 3600 : null,
        confirmedOnce: state.confirmedOnce,
    };
}

const need = (id: string): Row => {
    const r = state.rows.get(id);
    if (!r) throw new ApiError("no such run, track or playlist", 404);
    return r;
};

export function fakeApi(): Api {
    return {
        async me() {
            await pause(100);
        },
        async status() {
            await pause(150);
            return status();
        },
        async start() {
            await pause(300);
            const existing = runView();
            if (
                existing &&
                (existing.state === "running" || existing.state === "awaiting" || existing.state === "queued")
            )
                return { run: existing, created: false };
            state.run = {
                id: Math.random().toString(16).slice(2, 10).padEnd(8, "0"),
                started: now(),
                confirmed: false,
                cancelled: false,
                kind: "manual",
            };
            return { run: runView() as Run, created: true };
        },
        async confirm() {
            await pause(200);
            if (state.run) {
                state.run.confirmed = true;
                state.run.started = now() - 12.5; // straight on to filing
            }
            return runView() as Run;
        },
        async cancel() {
            await pause(200);
            if (state.run) state.run.cancelled = true;
            return runView() as Run;
        },
        async runs() {
            await pause(150);
            return state.runs;
        },
        async inbox(filter: InboxFilter, offset, limit) {
            await pause(200);
            if (filter === "gone") return { total: state.gone.length, videos: [], playlists: state.gone };
            const rows = [...state.rows.values()].filter((r) => r.status === (filter === "review" ? "review" : filter));
            return { total: rows.length, videos: rows.slice(offset, offset + limit), playlists: [] };
        },
        async pick(id, candidateId) {
            await pause(150);
            const r = need(id);
            const c = r.candidates.find((x) => x.id === candidateId);
            r.picked = c ? c.id : null;
            r.genre = c?.genre ?? null;
            const group = state.config.groups.find((g) => c?.genre && g.genres.includes(c.genre));
            r.group = group?.id ?? "other";
            return { ...r };
        },
        async search(id, query) {
            await pause(500);
            const r = need(id);
            r.query = query;
            r.candidates = [candidate(Number(id.replace("demo", "")) + 200, "Techno (Raw / Deep / Hypnotic)", 0.7)];
            r.status = "review";
            return { ...r };
        },
        async skip(id) {
            await pause(150);
            const r = need(id);
            r.status = "skipped";
            r.picked = null;
            return { ...r };
        },
        async restore(id) {
            await pause(150);
            const r = need(id);
            r.status = "review";
            return { ...r };
        },
        async setGroup(id, group) {
            await pause(150);
            const r = need(id);
            r.groupOverride = group;
            if (group) r.group = group;
            return { ...r };
        },
        async saveConfig(patch) {
            await pause(300);
            if (patch.cap !== undefined && (patch.cap < 1 || patch.cap > 2000))
                throw new ApiError("tracks per playlist must be a whole number from 1 to 2000", 400);
            if (patch.groups) state.config.groups = patch.groups;
            const { nightly, groups: _groups, ...rest } = patch;
            Object.assign(state.config, rest);
            if (nightly) Object.assign(state.config.nightly, nightly);
            return state.config;
        },
        async importJob(jobId) {
            await pause(300);
            if (jobId !== "6aad4181") throw new ApiError("no such run, track or playlist", 404);
            return { imported: 1521, total: 1521 };
        },
        async resolveGone(playlistId) {
            await pause(200);
            state.gone = state.gone.filter((g) => g.id !== playlistId);
        },
    };
}
