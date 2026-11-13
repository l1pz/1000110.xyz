/** Pure decisions behind the screens: what to say, which buttons to offer, how to edit the groups and the settings. */
import { duration, EPSILON, progressBar, type Tone } from "../../backend";
import {
    type Config,
    type Counts,
    type Group,
    type Health,
    type InboxFilter,
    MAX_CAP,
    MAX_GROUPS,
    MAX_NAME,
    OTHER,
    type Preview,
    type Row,
    type Run,
    type RunPhase,
    type Status,
} from "./api";

// --- a run -------------------------------------------------------------------------------------------------------

export const isActive = (run: Run | null): boolean => !!run && (run.state === "queued" || run.state === "running");
/** A run that still needs the page's attention: going, or waiting for a yes. */
export const isOpen = (run: Run | null): boolean => isActive(run) || run?.state === "awaiting";

const STEPS: Exclude<RunPhase, "finished">[] = ["youtube", "beatport", "plan", "match", "file"];
const WORDS: Record<RunPhase, string> = {
    youtube: "reading your YouTube likes",
    beatport: "reading your Beatport playlists",
    plan: "working out what is new",
    match: "matching new songs on Beatport",
    file: "adding songs to the playlists",
    finished: "finishing",
};
/** The phases share the bar by how long they usually take. */
const WEIGHTS: Record<Exclude<RunPhase, "finished">, number> = {
    youtube: 0.05,
    beatport: 0.1,
    plan: 0.02,
    match: 0.5,
    file: 0.33,
};

export function runRatio(run: Run): number {
    if (run.state === "done" || run.phase === "finished") return 1;
    const at = STEPS.indexOf(run.phase as Exclude<RunPhase, "finished">);
    let sum = 0;
    for (const phase of STEPS.slice(0, Math.max(0, at))) sum += WEIGHTS[phase];
    const weight = WEIGHTS[run.phase as keyof typeof WEIGHTS] ?? 0;
    if (run.progress && run.progress.total > 0) sum += weight * Math.min(1, run.progress.done / run.progress.total);
    return Math.min(1, sum);
}

export function runBar(run: Run): string {
    return `${progressBar(runRatio(run))} ${Math.floor(runRatio(run) * 100 + EPSILON)}%`;
}

/** `step 4 of 5: matching new songs on Beatport 120/340`. */
export function phaseText(run: Run): string {
    const at = STEPS.indexOf(run.phase as Exclude<RunPhase, "finished">);
    const count = run.progress && run.progress.total > 0 ? ` ${run.progress.done}/${run.progress.total}` : "";
    return `${at >= 0 ? `step ${at + 1} of ${STEPS.length}: ` : ""}${WORDS[run.phase]}${count}`;
}

export function runMark(run: Run): { text: string; tone: Tone } {
    switch (run.state) {
        case "queued":
            return { text: "[..]", tone: "idle" };
        case "running":
            return { text: "[>>]", tone: "run" };
        case "awaiting":
            return { text: "[??]", tone: "warn" };
        case "failed":
            return { text: "[!!]", tone: "bad" };
        case "cancelled":
            return { text: "[--]", tone: "idle" };
        default:
            return { text: "[ok]", tone: "ok" };
    }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What the first run is about to do, one line per group, and what it leaves out. */
export function previewLines(p: Preview): string[] {
    const lines = p.groups.map((g) => {
        const lists = g.newPlaylists > 0 ? ` (${plural(g.newPlaylists, "new playlist")})` : "";
        return `${g.name}: add ${plural(g.add, "song")}${lists}`;
    });
    const left = [p.review > 0 ? `${p.review} not sure` : "", p.notFound > 0 ? `${p.notFound} not found` : ""].filter(
        Boolean,
    );
    if (left.length) lines.push(`left out for now: ${left.join(", ")} (you can look at them later)`);
    return lines;
}

export function previewHeadline(p: Preview): string {
    return `${plural(p.total, "song")} will be added to ${plural(p.newPlaylists, "new playlist")} on Beatport`;
}

/** How a finished run went, for the history list. */
export function runSummary(run: Run, now: number): string {
    const when = `${duration(now - run.created)} ago`;
    const kind = run.kind === "auto" ? "nightly" : "by hand";
    const c = run.counts;
    const bits =
        run.state === "done"
            ? [
                  c.added ? `+${c.added} added` : "nothing new",
                  c.newLikes ? `${c.newLikes} new likes` : "",
                  c.unavailable ? `${c.unavailable} could not be added` : "",
                  c.dismissed ? `${c.dismissed} you removed` : "",
              ]
            : run.state === "failed"
              ? [run.error?.message ?? "failed"]
              : [run.state];
    return `${when} · ${kind} · ${bits.filter(Boolean).join(" · ")}`;
}

// --- health and the home page ------------------------------------------------------------------------------------

export const COOKIE_FIX =
    "export fresh YouTube cookies (a cookies.txt from a browser logged in to your account) and save them as " +
    "data/youtube-cookies.txt in the sc2bp folder on the server, then press sync now";

export interface HealthModel {
    mark: { text: string; tone: Tone };
    text: string;
    fix: string | null;
}

export function healthModel(h: Health): HealthModel {
    switch (h.status) {
        case "ok":
            return { mark: { text: "[ok]", tone: "ok" }, text: "all good", fix: null };
        case "unconfigured":
            return { mark: { text: "[..]", tone: "idle" }, text: "not set up yet: press sync now to start", fix: null };
        case "needs-cookies":
            return { mark: { text: "[!!]", tone: "bad" }, text: "your YouTube login has expired", fix: COOKIE_FIX };
        case "stale":
            return {
                mark: { text: "[!!]", tone: "warn" },
                text: "no good sync for more than 36 hours",
                fix: "press sync now and see what it says",
            };
        case "broken":
            return {
                mark: { text: "[!!]", tone: "bad" },
                text: h.message || "the saved state could not be read",
                fix: "the file was left as it is; the server log has the details",
            };
        default:
            return {
                mark: { text: "[!!]", tone: "bad" },
                text: `the last sync failed: ${h.message}`,
                fix: "press sync now to try again",
            };
    }
}

export function summaryLines(c: Counts): string[] {
    const first = [`${c.liked} liked`, `${c.onBeatport} on Beatport`];
    const second = [
        c.review ? `${c.review} not sure` : "",
        c.notFound ? `${c.notFound} not found` : "",
        c.unavailable ? `${c.unavailable} can't be added` : "",
        c.gone ? `${plural(c.gone, "playlist")} gone` : "",
    ].filter(Boolean);
    return [first.join(" · "), ...(second.length ? [second.join(" · ")] : [])];
}

const pad = (n: number) => String(n).padStart(2, "0");
export const nightlyTime = (n: { hour: number; minute: number }): string => `${pad(n.hour)}:${pad(n.minute)}`;

export function whenText(ts: number | null, now: number): string {
    if (ts === null) return "never";
    return now - ts < 10 ? "just now" : `${duration(now - ts)} ago`;
}

/** `next automatic sync in 14h 20m (04:30)`, or why there is none. */
export function nextText(s: Status, now: number): string {
    const n = s.config.nightly;
    if (!n.enabled) return "automatic sync is off";
    if (!s.confirmedOnce) return "automatic sync starts after the first good sync";
    return s.nextAuto === null
        ? "automatic sync is on"
        : `next automatic sync in ${duration(s.nextAuto - now)} (${nightlyTime(n)})`;
}

/** How long to wait before asking again: fast while something runs, slow when idle, slower in a hidden tab. */
export function pollDelay(run: Run | null, hidden: boolean): number {
    if (isActive(run)) return hidden ? 15_000 : 2_000;
    if (run?.state === "awaiting") return hidden ? 30_000 : 5_000;
    return hidden ? 120_000 : 30_000;
}

export function tabTitle(run: Run | null, base: string): string {
    if (isActive(run)) return `(syncing) ${base}`;
    if (run?.state === "awaiting") return `(waiting for you) ${base}`;
    return base;
}

// --- the inbox ---------------------------------------------------------------------------------------------------

const TABS: InboxFilter[] = ["review", "notfound", "unavailable", "skipped", "gone"];

/** A tab name from the address, or false for anything else. */
export const isTab = (value: string | null): value is InboxFilter => TABS.includes(value as InboxFilter);

export interface InboxTab {
    filter: InboxFilter;
    label: string;
    count: number;
}

/** The inbox's tabs; empty ones are left out, except the one being looked at. */
export function inboxTabs(c: Counts, current: InboxFilter): InboxTab[] {
    const all: InboxTab[] = [
        { filter: "review", label: "not sure", count: c.review },
        { filter: "notfound", label: "not found", count: c.notFound },
        { filter: "unavailable", label: "can't be added", count: c.unavailable },
        { filter: "skipped", label: "skipped", count: c.skipped },
        { filter: "gone", label: "gone playlists", count: c.gone },
    ];
    return all.filter((t) => t.count > 0 || t.filter === current);
}

export const EMPTY_TEXT: Record<InboxFilter, string> = {
    review: "nothing to decide: every song was matched or not found",
    notfound: "every song was found on Beatport",
    unavailable: "nothing Beatport refused",
    skipped: "you have not skipped anything",
    gone: "all the playlists are where they should be",
};

/** What the sync will do next with a song that is waiting, in a few words. */
export function rowNote(row: Row, now: number): string | null {
    const checks = row.checks;
    if (row.status === "notfound" && checks) {
        if (checks.n >= 3) return "searched 3 times; not looking again unless you search by hand";
        return checks.next > now
            ? `searches again in ${duration(checks.next - now)}`
            : "searches again on the next sync";
    }
    if (row.status === "unavailable" && checks) {
        if (checks.n >= 3) return "Beatport would not keep it after 3 tries; giving up";
        return checks.next > now
            ? `Beatport did not keep it; tries again in ${duration(checks.next - now)}`
            : "tries again on the next sync";
    }
    if (row.status === "unreadable") return "could not be read (private or deleted on YouTube)";
    return null;
}

export function groupName(groups: { id: string; name: string }[], id: string): string {
    return groups.find((g) => g.id === id)?.name ?? id;
}

// --- groups ------------------------------------------------------------------------------------------------------

/** Takes `genre` out of every group and puts it into `to`; `null` leaves it unlisted, so it goes to the catch-all. */
export function moveGenre(groups: Group[], genre: string, to: string | null): Group[] {
    return groups.map((g) => {
        const rest = g.genres.filter((x) => x !== genre);
        return { ...g, genres: g.id === to ? [...rest, genre] : rest };
    });
}

/** The group a genre is in (`other` when none lists it). */
export function groupOfGenre(groups: Group[], genre: string): string {
    return groups.find((g) => g.genres.includes(genre))?.id ?? OTHER;
}

export function slug(name: string, taken: string[]): string {
    const base =
        name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 26) || "group";
    let id = base === OTHER ? "group" : base;
    for (let n = 2; taken.includes(id); n++) id = `${base.slice(0, 26)}-${n}`;
    return id;
}

/** Why a group name is not allowed, or null. */
export function nameProblem(name: string, others: string[]): string | null {
    const t = name.trim();
    if (t.length < 1 || t.length > MAX_NAME) return `a name is 1 to ${MAX_NAME} characters`;
    if (t.includes("#")) return "a name cannot contain #";
    if (others.some((o) => o.trim().toLowerCase() === t.toLowerCase())) return "another group already has that name";
    return null;
}

export function addGroup(groups: Group[], name: string, otherName: string): { groups: Group[]; error: string | null } {
    if (groups.length >= MAX_GROUPS) return { groups, error: `at most ${MAX_GROUPS} groups` };
    const error = nameProblem(name, [...groups.map((g) => g.name), otherName]);
    if (error) return { groups, error };
    const ids = groups.map((g) => g.id);
    return { groups: [...groups, { id: slug(name, ids), name: name.trim(), genres: [] }], error: null };
}

export function removeGroup(groups: Group[], id: string): Group[] {
    return groups.filter((g) => g.id !== id); // its genres are unlisted, so they go to the catch-all
}

export function renameGroup(
    groups: Group[],
    id: string,
    name: string,
    otherName: string,
): { groups: Group[]; error: string | null } {
    const error = nameProblem(name, [...groups.filter((g) => g.id !== id).map((g) => g.name), otherName]);
    if (error) return { groups, error };
    return { groups: groups.map((g) => (g.id === id ? { ...g, name: name.trim() } : g)), error: null };
}

/** The ids of groups that have playlists on Beatport: their names are in those playlist names, so they are locked. */
export function lockedGroups(s: Status): Set<string> {
    return new Set(s.groups.filter((g) => g.playlists.length > 0).map((g) => g.id));
}

export const hasPlaylists = (s: Status): boolean => s.groups.some((g) => g.playlists.length > 0);

// --- settings ----------------------------------------------------------------------------------------------------

/** `04:30`, `4:30`, `4.30` as hour and minute; null for anything else. */
export function parseTime(text: string): { hour: number; minute: number } | null {
    const m = /^(\d{1,2})[:.](\d{2})$/.exec(text.trim());
    if (!m) return null;
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

export interface SettingsForm {
    source: string;
    prefix: string;
    cap: string;
    nightly: boolean;
    time: string;
}

/** The change to send, only what differs from `current`, or the first thing wrong with the form. */
export function settingsPatch(
    form: SettingsForm,
    current: Config,
): { patch: import("./api").ConfigPatch; error: string | null } {
    const patch: import("./api").ConfigPatch = {};
    const source = form.source.trim();
    if (!source) return { patch, error: "the YouTube playlist link cannot be empty" };
    if (source !== current.source) patch.source = source;
    const prefix = form.prefix.trim();
    if (prefix.length < 1 || prefix.length > MAX_NAME || prefix.includes("#")) {
        return { patch, error: `the playlist name prefix is 1 to ${MAX_NAME} characters, without #` };
    }
    if (prefix !== current.prefix) patch.prefix = prefix;
    const cap = Number(form.cap.trim());
    if (!form.cap.trim() || !Number.isInteger(cap) || cap < 1 || cap > MAX_CAP) {
        return { patch, error: `tracks per playlist is a whole number from 1 to ${MAX_CAP}` };
    }
    if (cap !== current.cap) patch.cap = cap;
    const time = parseTime(form.time);
    if (!time) return { patch, error: "the nightly time is hours and minutes, like 04:30" };
    const nightly: Partial<Config["nightly"]> = {};
    if (form.nightly !== current.nightly.enabled) nightly.enabled = form.nightly;
    if (time.hour !== current.nightly.hour) nightly.hour = time.hour;
    if (time.minute !== current.nightly.minute) nightly.minute = time.minute;
    if (Object.keys(nightly).length) patch.nightly = nightly;
    return { patch, error: null };
}
