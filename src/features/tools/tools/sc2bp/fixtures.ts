import { type Api, ApiError, type Candidate, type Counts, type Filter, type Job, type Phase, type Track } from "./api";

/**
 * A fake server for `npm run dev`, so every screen can be looked at without the backend. Never bundled for production.
 * Jobs advance with the clock. The link decides what happens: a link with `fail` fails while listing, `pause` pauses
 * during matching with a retry countdown, `big` is 400 tracks and slow; anything else is 40 tracks and takes ~15 s.
 */
interface Fake {
    id: string;
    url: string;
    name: string;
    created: number;
    kind: "ok" | "fail" | "pause" | "big";
    total: number;
    /** Seconds the job has been stopped for (cancel, pause, failure): the clock for its progress stands still. */
    lost: number;
    stoppedAt: number | null;
    stop: "cancelled" | null;
    picks: Map<number, number | null>;
    extra: Map<number, Candidate[]>;
    applied: Set<number>;
    applyUntil: number | null;
}

const PHASES: [Exclude<Phase, "finished">, number][] = [
    ["listing", 1.5],
    ["reading", 4],
    ["matching", 8],
    ["creating", 2],
];

const now = () => Date.now() / 1000;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** What the fake Beatport says about track `i`: seven in ten match, one is unsure, two are not found. */
function verdictOf(i: number): "match" | "maybe" | "none" {
    const r = i % 10;
    return r < 7 ? "match" : r === 7 ? "maybe" : "none";
}
const unreadable = (i: number, total: number) => total >= 20 && (i === 5 || i === 17);

function candidatesOf(i: number): Candidate[] {
    const make = (id: number, title: string, mix: string, score: number): Candidate => ({
        id,
        title,
        mix,
        artists: [`Artist ${i}`],
        durationSec: 300 + i,
        score,
    });
    const verdict = verdictOf(i);
    if (verdict === "match") return [make(10_000 + i, `Song ${i}`, "Original Mix", 1)];
    if (verdict === "maybe") {
        return [
            make(20_000 + i, `Song ${i}`, "Extended Mix", 0.78),
            make(30_000 + i, `Song ${i} (Reprise)`, "Original Mix", 0.64),
            make(40_000 + i, `Songs ${i}`, "Radio Edit", 0.58),
        ];
    }
    return [];
}

/** Like the real server, the jobs outlive a mount: the tool remounts on every hash change. */
const jobs = new Map<string, Fake>();

export function fakeApi(): Api {
    const elapsed = (f: Fake, t = now()) => (f.stoppedAt ?? t) - f.created - f.lost;
    const scale = (f: Fake) => (f.kind === "big" ? 6 : 1);

    function snapshot(f: Fake): Job {
        const t = now();
        const e = elapsed(f, t);
        let phase: Phase = "finished";
        let progress = { phase: "finished" as Phase, done: 1, total: 1 };
        let left = e;
        for (const [name, secs] of PHASES) {
            const span = secs * scale(f);
            if (left < span) {
                const total = name === "listing" ? 0 : f.total;
                phase = name;
                progress = { phase: name, done: Math.floor((left / span) * total), total };
                break;
            }
            left -= span;
        }
        let state: Job["state"] = phase === "finished" ? "done" : "running";
        let error: Job["error"] = null;
        let waiting: Job["waiting"] = null;
        if (f.stop === "cancelled") state = "cancelled";
        else if (f.kind === "fail" && e >= 3) {
            state = "failed";
            phase = progress.phase = "listing";
            error = {
                message: "yt-dlp could not read that playlist (private, deleted, or SoundCloud changed)",
                phase: "listing",
            };
        } else if (f.kind === "pause" && e >= 6) {
            state = "paused";
            phase = progress.phase = "matching";
            progress = { phase: "matching", done: Math.floor(f.total * 0.4), total: f.total };
            error = {
                message: "Beatport keeps failing (Beatport answered 503 for GET /catalog/search/)",
                phase: "matching",
            };
        }
        if (state === "running" && f.kind === "pause" && e >= 4.5 && e < 6) {
            waiting = { until: t + (6 - e), reason: "searching Beatport: Beatport answered 503" };
        }
        if (f.stoppedAt === null && (state === "failed" || state === "paused")) f.stoppedAt = t;
        if (f.applyUntil !== null) {
            if (t < f.applyUntil) {
                state = "running";
                phase = progress.phase = "creating";
                progress = { phase: "creating", done: 0, total: pendingOf(f).length };
            } else {
                for (const i of pendingOf(f)) f.applied.add(i);
                f.applyUntil = null;
            }
        }

        const readDone = progress.phase === "listing" ? 0 : progress.phase === "reading" ? progress.done : f.total;
        const matchDone = ["listing", "reading"].includes(progress.phase)
            ? 0
            : progress.phase === "matching"
              ? progress.done
              : f.total;
        const counts: Counts = { match: 0, maybe: 0, none: 0, error: 0, unreadable: 0, picked: 0, added: 0 };
        for (let i = 0; i < readDone; i++) if (unreadable(i, f.total)) counts.unreadable++;
        for (let i = 0; i < matchDone; i++) {
            if (unreadable(i, f.total)) continue;
            counts[verdictOf(i)]++;
            if (pickOf(f, i) !== null) counts.picked++;
        }
        const finished = state === "done" || (f.stop === null && phase === "creating");
        if (state === "done")
            for (let i = 0; i < f.total; i++) if (pickOf(f, i) !== null && isAdded(f, i)) counts.added++;
        const review = [...Array(matchDone).keys()].filter(
            (i) => !unreadable(i, f.total) && pickOf(f, i) === null,
        ).length;
        return {
            id: f.id,
            name: f.name,
            url: f.url,
            state,
            phase,
            created: f.created,
            updated: state === "done" || state === "cancelled" || state === "failed" ? f.created + e : t,
            total: readDone > 0 || f.kind !== "fail" ? f.total : 0,
            progress,
            counts,
            needsReview: review,
            pendingPicks: pendingOf(f).length,
            waiting,
            error,
            playlist:
                finished || counts.added > 0
                    ? { id: 77, url: "https://www.beatport.com/library/playlists/77", name: f.name }
                    : null,
        };
    }

    const pickOf = (f: Fake, i: number): number | null =>
        f.picks.has(i) ? (f.picks.get(i) ?? null) : verdictOf(i) === "match" ? 10_000 + i : null;
    const isAdded = (f: Fake, i: number) => verdictOf(i) === "match" || f.applied.has(i);
    const pendingOf = (f: Fake): number[] =>
        [...f.picks.entries()]
            .filter(([i, id]) => id !== null && !f.applied.has(i) && verdictOf(i) !== "match")
            .map(([i]) => i);

    function trackOf(f: Fake, i: number): Track {
        const gone = unreadable(i, f.total);
        const verdict = gone ? null : verdictOf(i);
        const label = gone ? "(could not be read)" : `Artist ${i} - Song ${i}`;
        return {
            index: i,
            url: `https://soundcloud.com/demo/track-${i}`,
            label,
            title: gone ? "" : label,
            uploader: "Demo",
            durationSec: gone ? null : 300 + i,
            state: gone ? "unreadable" : "matched",
            verdict,
            picked: gone ? null : pickOf(f, i),
            added: !gone && pickOf(f, i) !== null && isAdded(f, i),
            error: null,
            query: `Artist ${i} Song ${i}`,
            candidates: f.extra.get(i) ?? (gone ? [] : candidatesOf(i)),
        };
    }

    const need = (id: string): Fake => {
        const f = jobs.get(id);
        if (!f) throw new ApiError("no such job or track", 404);
        return f;
    };

    return {
        async me() {
            await pause(100);
        },
        async start(url, name) {
            await pause(300);
            const existing = [...jobs.values()].find(
                (f) => f.url === url && ["running", "queued", "paused"].includes(snapshot(f).state),
            );
            if (existing) return { job: snapshot(existing), created: false };
            const kind = url.includes("fail")
                ? "fail"
                : url.includes("pause")
                  ? "pause"
                  : url.includes("big")
                    ? "big"
                    : "ok";
            const f: Fake = {
                id: Math.random().toString(16).slice(2, 10).padEnd(8, "0"),
                url,
                name: name || (url.split("/").filter(Boolean).pop() ?? "playlist"),
                created: now(),
                kind,
                total: kind === "big" ? 400 : 40,
                lost: 0,
                stoppedAt: null,
                stop: null,
                picks: new Map(),
                extra: new Map(),
                applied: new Set(),
                applyUntil: null,
            };
            jobs.set(f.id, f);
            return { job: snapshot(f), created: true };
        },
        async list() {
            await pause(100);
            return [...jobs.values()].map(snapshot).sort((a, b) => b.created - a.created);
        },
        async get(id) {
            await pause(80);
            return snapshot(need(id));
        },
        async tracks(id, filter: Filter, offset, limit) {
            await pause(150);
            const f = need(id);
            const wanted = (i: number): boolean => {
                const t = trackOf(f, i);
                const picked = t.picked !== null;
                return {
                    all: true,
                    picked,
                    unmatched: t.state === "matched" && !picked,
                    maybe: t.verdict === "maybe" && !picked,
                    none: t.verdict === "none" && !picked,
                    error: false,
                    unreadable: t.state === "unreadable",
                }[filter];
            };
            const rows = [...Array(f.total).keys()].filter(wanted);
            return { total: rows.length, tracks: rows.slice(offset, offset + limit).map((i) => trackOf(f, i)) };
        },
        async cancel(id) {
            const f = need(id);
            const s = snapshot(f);
            if (s.state !== "running" && s.state !== "queued")
                throw new ApiError(`a ${s.state} job cannot be cancelled`, 409);
            f.stop = "cancelled";
            f.stoppedAt = now();
            return snapshot(f);
        },
        async retry(id) {
            const f = need(id);
            const s = snapshot(f);
            if (s.state === "running" || s.state === "queued") throw new ApiError("that job is already running", 409);
            if (f.stoppedAt !== null) f.lost += now() - f.stoppedAt;
            f.stoppedAt = null;
            f.stop = null;
            if (f.kind === "fail" || f.kind === "pause") f.kind = "ok";
            return snapshot(f);
        },
        async apply(id) {
            await pause(200);
            const f = need(id);
            if (pendingOf(f).length === 0) throw new ApiError("no new picks to add", 409);
            f.applyUntil = now() + 1.5;
            return snapshot(f);
        },
        async remove(id) {
            need(id);
            jobs.delete(id);
        },
        async pick(id, index, candidateId) {
            await pause(120);
            const f = need(id);
            if (f.applied.has(index)) throw new ApiError("that track is already in the Beatport playlist", 409);
            f.picks.set(index, candidateId);
            return trackOf(f, index);
        },
        async search(id, index, query) {
            await pause(500);
            const f = need(id);
            f.picks.set(index, null);
            f.extra.set(
                index,
                query.toLowerCase().includes("nothing")
                    ? []
                    : [
                          {
                              id: 50_000 + index,
                              title: query,
                              mix: "Original Mix",
                              artists: ["Found Artist"],
                              durationSec: 301,
                              score: 0.71,
                          },
                          {
                              id: 60_000 + index,
                              title: `${query} (Dub)`,
                              mix: "Dub Mix",
                              artists: ["Found Artist"],
                              durationSec: 402,
                              score: 0.52,
                          },
                      ],
            );
            return { ...trackOf(f, index), query };
        },
    };
}
