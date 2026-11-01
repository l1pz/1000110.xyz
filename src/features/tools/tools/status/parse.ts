/**
 * Turns Uptime Kuma's status-page JSON into something the view can draw. Kuma's JSON is internal and not a stable
 * API, so everything is checked: a shape we do not know gives `null` ("status unavailable"), never a guess.
 */

export type Beat = "up" | "down" | "pending" | "maintenance" | "none";
/** What a monitor is right now: its last beat, or `stale` when that beat is too old to call live. */
export type Now = Beat | "stale";

export interface Monitor {
    id: number;
    name: string;
    /** Oldest first. */
    beats: Beat[];
    /** Time of the last beat (ms since 1970), `null` when there is none. */
    last: number | null;
    /** 24 hour uptime, 0 to 1; `null` when Kuma gave none. */
    uptime: number | null;
}

export interface Group {
    name: string;
    monitors: Monitor[];
}

export interface Report {
    groups: Group[];
}

/** Monitors beat every minute; five minutes without a beat means paused, or Kuma itself is stuck. */
export const STALE_MS = 5 * 60_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const BEATS: Record<number, Beat> = { 0: "down", 1: "up", 2: "pending", 3: "maintenance" };

/** Kuma writes `2026-10-31 20:07:26.046` in UTC. */
export function beatTime(text: string): number | null {
    const ms = Date.parse(`${text.replace(" ", "T")}Z`);
    return Number.isNaN(ms) ? null : ms;
}

function parseBeats(list: unknown): { beats: Beat[]; last: number | null } | null {
    if (list === undefined) return { beats: [], last: null };
    if (!Array.isArray(list)) return null;
    const beats: Beat[] = [];
    let last: number | null = null;
    for (const item of list) {
        if (!isRecord(item) || typeof item.status !== "number" || typeof item.time !== "string") return null;
        beats.push(BEATS[item.status] ?? "none");
        const time = beatTime(item.time);
        if (time !== null && (last === null || time > last)) last = time;
    }
    return { beats, last };
}

/** `pageJson` is `/api/status-page/<slug>`, `beatJson` is `/api/status-page/heartbeat/<slug>`. */
export function parseStatus(pageJson: unknown, beatJson: unknown): Report | null {
    if (!isRecord(pageJson) || !Array.isArray(pageJson.publicGroupList)) return null;
    if (!isRecord(beatJson) || !isRecord(beatJson.heartbeatList)) return null;
    const uptimes = isRecord(beatJson.uptimeList) ? beatJson.uptimeList : {};
    const groups: Group[] = [];
    for (const g of pageJson.publicGroupList) {
        if (!isRecord(g) || typeof g.name !== "string" || !Array.isArray(g.monitorList)) return null;
        const monitors: Monitor[] = [];
        for (const m of g.monitorList) {
            if (!isRecord(m) || typeof m.id !== "number" || typeof m.name !== "string") return null;
            const parsed = parseBeats(beatJson.heartbeatList[String(m.id)]);
            if (!parsed) return null;
            const up = uptimes[`${m.id}_24`];
            monitors.push({
                id: m.id,
                name: m.name,
                ...parsed,
                uptime: typeof up === "number" && up >= 0 && up <= 1 ? up : null,
            });
        }
        groups.push({ name: g.name, monitors });
    }
    if (!groups.some((g) => g.monitors.length > 0)) return null;
    return { groups };
}

export function monitorNow(m: Monitor, now: number): Now {
    if (m.last === null || m.beats.length === 0) return "none";
    if (now - m.last > STALE_MS) return "stale";
    return m.beats[m.beats.length - 1];
}

export interface Overall {
    kind: "ok" | "warn" | "down";
    text: string;
}

export function overall(report: Report, now: number): Overall {
    const all = report.groups.flatMap((g) => g.monitors).map((m) => monitorNow(m, now));
    const down = all.filter((s) => s === "down").length;
    const off = all.filter((s) => s !== "up" && s !== "down" && s !== "maintenance").length;
    if (down > 0) return { kind: "down", text: `${down} of ${all.length} down` };
    if (off > 0) return { kind: "warn", text: `${off} of ${all.length} not reporting` };
    return { kind: "ok", text: "all systems operational" };
}

/** The last `n` beats, oldest first, padded on the left with `none` when there are fewer. */
export function lastBeats(beats: Beat[], n: number): Beat[] {
    const tail = beats.slice(-n);
    return [...Array<Beat>(n - tail.length).fill("none"), ...tail];
}
