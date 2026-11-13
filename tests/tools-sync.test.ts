import { describe, expect, it } from "vitest";
import { AuthError } from "../src/features/tools/auth";
import { ApiError } from "../src/features/tools/backend";
import {
    type Config,
    type Counts,
    type Group,
    type Health,
    OTHER,
    type Preview,
    type Row,
    type Run,
    realApi,
    type Status,
} from "../src/features/tools/tools/sync/api";
import { hashFor } from "../src/features/tools/tools/sync/chrome";
import {
    addGroup,
    COOKIE_FIX,
    groupOfGenre,
    hasPlaylists,
    healthModel,
    inboxTabs,
    isActive,
    isOpen,
    isTab,
    lockedGroups,
    moveGenre,
    nameProblem,
    nextText,
    nightlyTime,
    parseTime,
    phaseText,
    pollDelay,
    previewHeadline,
    previewLines,
    removeGroup,
    renameGroup,
    rowNote,
    runBar,
    runMark,
    runRatio,
    runSummary,
    settingsPatch,
    slug,
    summaryLines,
    tabTitle,
    whenText,
} from "../src/features/tools/tools/sync/model";

const run = (over: Partial<Run> = {}): Run => ({
    id: "a1b2c3d4",
    kind: "manual",
    state: "running",
    phase: "match",
    created: 1000,
    updated: 1100,
    finished: null,
    counts: { newLikes: 0, searched: 0, matched: 0, added: 0, unavailable: 0, dismissed: 0 },
    error: null,
    waiting: null,
    confirmed: false,
    preview: null,
    progress: null,
    ...over,
});

const counts = (over: Partial<Counts> = {}): Counts => ({
    liked: 1530,
    onBeatport: 744,
    review: 0,
    notFound: 0,
    unavailable: 0,
    skipped: 0,
    unreadable: 0,
    dismissed: 0,
    unliked: 0,
    gone: 0,
    needYou: 0,
    ...over,
});

const groups = (): Group[] => [
    { id: "techno", name: "Techno", genres: ["Techno (Peak)", "Hard Techno"] },
    { id: "house", name: "House & Melodic", genres: ["House"] },
];

const config = (over: Partial<Config> = {}): Config => ({
    source: "https://www.youtube.com/playlist?list=LM",
    prefix: "Liked",
    cap: 100,
    nightly: { enabled: false, hour: 4, minute: 30, tz: "Europe/Budapest" },
    groups: groups(),
    otherName: "Other",
    ...over,
});

const status = (over: Partial<Status> = {}): Status => ({
    config: config(),
    health: { ok: true, configured: true, status: "ok", message: "" },
    run: null,
    counts: counts(),
    groups: [],
    otherGenres: {},
    lastSuccess: null,
    nextAuto: null,
    confirmedOnce: true,
    ...over,
});

describe("a run on the page", () => {
    it("tells which step it is on and how far", () => {
        expect(phaseText(run({ phase: "youtube" }))).toBe("step 1 of 5: reading your YouTube likes");
        expect(phaseText(run({ progress: { done: 120, total: 340 } }))).toBe(
            "step 4 of 5: matching new songs on Beatport 120/340",
        );
        expect(phaseText(run({ phase: "finished" }))).toBe("finishing");
    });

    it("fills the bar by phase weights and never past 100%", () => {
        expect(runRatio(run({ phase: "youtube" }))).toBe(0);
        expect(runRatio(run({ phase: "match", progress: { done: 1, total: 2 } }))).toBeCloseTo(0.17 + 0.25, 5);
        expect(runRatio(run({ phase: "file", progress: { done: 5, total: 5 } }))).toBeCloseTo(1, 5);
        expect(runRatio(run({ state: "done", phase: "finished" }))).toBe(1);
        expect(runRatio(run({ phase: "match", progress: { done: 9, total: 3 } }))).toBeLessThanOrEqual(1);
        expect(runBar(run({ state: "done", phase: "finished" }))).toBe("[████████████████████] 100%");
    });

    it("marks every state", () => {
        const states: Run["state"][] = ["queued", "running", "awaiting", "done", "failed", "cancelled"];
        expect(states.map((state) => runMark(run({ state })).text)).toEqual([
            "[..]",
            "[>>]",
            "[??]",
            "[ok]",
            "[!!]",
            "[--]",
        ]);
    });

    it("knows which runs need attention", () => {
        expect(isActive(run({ state: "queued" }))).toBe(true);
        expect(isActive(run({ state: "awaiting" }))).toBe(false);
        expect(isOpen(run({ state: "awaiting" }))).toBe(true);
        expect(isOpen(run({ state: "done" }))).toBe(false);
        expect(isOpen(null)).toBe(false);
    });

    it("sums up what a finished run did", () => {
        const done = run({
            state: "done",
            created: 940,
            counts: { ...run().counts, added: 12, newLikes: 14, unavailable: 2, dismissed: 1 },
        });
        expect(runSummary(done, 1000)).toBe(
            "1m ago · by hand · +12 added · 14 new likes · 2 could not be added · 1 you removed",
        );
        expect(runSummary(run({ state: "done", kind: "auto", created: 100 }), 1000)).toBe(
            "15m ago · nightly · nothing new",
        );
        expect(
            runSummary(
                run({
                    state: "failed",
                    error: { message: "cookies expired", phase: "youtube", kind: "cookies", retryable: false },
                }),
                1100,
            ),
        ).toContain("cookies expired");
    });
});

describe("the first run's preview", () => {
    const preview: Preview = {
        groups: [
            { id: "techno", name: "Techno", add: 259, newPlaylists: 3 },
            { id: "house", name: "House & Melodic", add: 1, newPlaylists: 1 },
            { id: "bass", name: "Bass", add: 5, newPlaylists: 0 },
        ],
        total: 265,
        newPlaylists: 4,
        review: 268,
        notFound: 0,
    };

    it("says what will be added and created", () => {
        expect(previewHeadline(preview)).toBe("265 songs will be added to 4 new playlists on Beatport");
        expect(previewHeadline({ ...preview, total: 1, newPlaylists: 1 })).toBe(
            "1 song will be added to 1 new playlist on Beatport",
        );
    });

    it("lists each group and what is left out, leaving empty facts out", () => {
        expect(previewLines(preview)).toEqual([
            "Techno: add 259 songs (3 new playlists)",
            "House & Melodic: add 1 song (1 new playlist)",
            "Bass: add 5 songs",
            "left out for now: 268 not sure (you can look at them later)",
        ]);
        expect(previewLines({ ...preview, review: 0 }).at(-1)).toBe("Bass: add 5 songs");
    });
});

describe("health and the home page", () => {
    const health = (status: Health["status"], message = ""): Health => ({
        ok: status === "ok" || status === "unconfigured",
        configured: status !== "unconfigured",
        status,
        message,
    });

    it("explains each health state and what to do", () => {
        expect(healthModel(health("ok")).mark.tone).toBe("ok");
        expect(healthModel(health("unconfigured")).text).toContain("press sync now");
        const cookies = healthModel(health("needs-cookies", "x"));
        expect(cookies.mark.tone).toBe("bad");
        expect(cookies.fix).toBe(COOKIE_FIX);
        expect(healthModel(health("failed", "Beatport answered 503")).text).toBe(
            "the last sync failed: Beatport answered 503",
        );
        expect(healthModel(health("stale")).mark.tone).toBe("warn");
        expect(healthModel(health("broken", "state.json could not be read")).text).toBe("state.json could not be read");
        expect(healthModel(health("ok")).fix).toBeNull();
    });

    it("sums up the counts and leaves zeros out", () => {
        expect(summaryLines(counts())).toEqual(["1530 liked · 744 on Beatport"]);
        expect(summaryLines(counts({ review: 268, notFound: 468, unavailable: 23, gone: 1 }))).toEqual([
            "1530 liked · 744 on Beatport",
            "268 not sure · 468 not found · 23 can't be added · 1 playlist gone",
        ]);
    });

    it("says when things happened and when the next sync is", () => {
        expect(whenText(null, 100)).toBe("never");
        expect(whenText(95, 100)).toBe("just now");
        expect(whenText(0, 3 * 3600)).toBe("3h 00m ago");
        expect(nightlyTime({ hour: 4, minute: 5 })).toBe("04:05");
        expect(nextText(status(), 0)).toBe("automatic sync is off");
        const on = config({ nightly: { enabled: true, hour: 4, minute: 30, tz: "Europe/Budapest" } });
        expect(nextText(status({ config: on, confirmedOnce: false }), 0)).toBe(
            "automatic sync starts after the first good sync",
        );
        expect(nextText(status({ config: on, nextAuto: 14 * 3600 + 1200 }), 0)).toBe(
            "next automatic sync in 14h 20m (04:30)",
        );
        expect(nextText(status({ config: on, nextAuto: null }), 0)).toBe("automatic sync is on");
    });

    it("asks often while something runs and rarely when idle or hidden", () => {
        expect(pollDelay(run(), false)).toBe(2000);
        expect(pollDelay(run(), true)).toBe(15000);
        expect(pollDelay(run({ state: "awaiting" }), false)).toBe(5000);
        expect(pollDelay(null, false)).toBe(30000);
        expect(pollDelay(run({ state: "done" }), true)).toBe(120000);
    });

    it("puts what is going on in the tab title", () => {
        expect(tabTitle(run(), "sync")).toBe("(syncing) sync");
        expect(tabTitle(run({ state: "awaiting" }), "sync")).toBe("(waiting for you) sync");
        expect(tabTitle(run({ state: "done" }), "sync")).toBe("sync");
    });
});

describe("the inbox", () => {
    it("shows the tabs that have something, and the one being looked at", () => {
        expect(inboxTabs(counts({ review: 3, gone: 1 }), "review").map((t) => t.filter)).toEqual(["review", "gone"]);
        expect(inboxTabs(counts(), "notfound").map((t) => t.filter)).toEqual(["notfound"]);
        expect(inboxTabs(counts({ notFound: 2 }), "review")).toEqual([
            { filter: "review", label: "not sure", count: 0 },
            { filter: "notfound", label: "not found", count: 2 },
        ]);
    });

    it("only takes tab names it knows", () => {
        expect(isTab("review")).toBe(true);
        expect(isTab("gone")).toBe(true);
        expect(isTab("nope")).toBe(false);
        expect(isTab(null)).toBe(false);
    });

    const row = (over: Partial<Row>): Row => ({
        id: "v1",
        url: "https://music.youtube.com/watch?v=v1",
        label: "A - B",
        title: "A - B",
        uploader: "A",
        durationSec: 200,
        status: "review",
        verdict: "maybe",
        picked: null,
        genre: null,
        group: OTHER,
        groupOverride: null,
        filed: false,
        dismissed: false,
        query: "A B",
        candidates: [],
        error: null,
        checks: null,
        ...over,
    });

    it("says what the sync will do next with a waiting song", () => {
        const now = 1000;
        expect(rowNote(row({ status: "notfound", checks: { n: 1, next: now + 3 * 86400 } }), now)).toBe(
            "searches again in 72h 00m",
        );
        expect(rowNote(row({ status: "notfound", checks: { n: 1, next: now - 5 } }), now)).toBe(
            "searches again on the next sync",
        );
        expect(rowNote(row({ status: "notfound", checks: { n: 3, next: now + 99 } }), now)).toContain(
            "not looking again",
        );
        expect(rowNote(row({ status: "unavailable", checks: { n: 1, next: now + 600 } }), now)).toBe(
            "Beatport did not keep it; tries again in 10m",
        );
        expect(rowNote(row({ status: "unavailable", checks: { n: 3, next: 0 } }), now)).toContain("giving up");
        expect(rowNote(row({ status: "unreadable" }), now)).toContain("private or deleted");
        expect(rowNote(row({ status: "review" }), now)).toBeNull();
    });
});

describe("editing the groups", () => {
    it("moves a genre out of every group and into one", () => {
        const next = moveGenre(groups(), "Hard Techno", "house");
        expect(next.map((g) => g.genres)).toEqual([["Techno (Peak)"], ["House", "Hard Techno"]]);
        expect(groups()[0].genres).toContain("Hard Techno"); // the original is not changed
    });

    it("moving to null leaves a genre unlisted, so it goes to the catch-all", () => {
        const next = moveGenre(groups(), "House", null);
        expect(next[1].genres).toEqual([]);
        expect(groupOfGenre(next, "House")).toBe(OTHER);
        expect(groupOfGenre(groups(), "House")).toBe("house");
    });

    it("makes ids from names, avoiding clashes and the catch-all id", () => {
        expect(slug("Drum & Bass", [])).toBe("drum-bass");
        expect(slug("Techno", ["techno"])).toBe("techno-2");
        expect(slug("Techno", ["techno", "techno-2"])).toBe("techno-3");
        expect(slug("Other", [])).toBe("group");
        expect(slug("!!!", [])).toBe("group");
        expect(slug("x".repeat(60), []).length).toBeLessThanOrEqual(30);
    });

    it("checks names the way the server does", () => {
        expect(nameProblem("Techno", [])).toBeNull();
        expect(nameProblem("  ", [])).toMatch(/1 to 40/);
        expect(nameProblem("x".repeat(41), [])).toMatch(/1 to 40/);
        expect(nameProblem("a#b", [])).toMatch(/#/);
        expect(nameProblem("techno", ["Techno"])).toMatch(/already/);
    });

    it("adds, renames and removes groups", () => {
        const added = addGroup(groups(), "  Trance ", "Other");
        expect(added.error).toBeNull();
        expect(added.groups.at(-1)).toEqual({ id: "trance", name: "Trance", genres: [] });
        expect(addGroup(groups(), "Techno", "Other").error).toMatch(/already/);
        expect(addGroup(groups(), "Other", "Other").error).toMatch(/already/);
        const many = Array.from({ length: 30 }, (_, i) => ({ id: `g${i}`, name: `G${i}`, genres: [] }));
        expect(addGroup(many, "One more", "Other").error).toMatch(/at most 30/);

        expect(renameGroup(groups(), "techno", "Hard & Techno", "Other").groups[0].name).toBe("Hard & Techno");
        expect(renameGroup(groups(), "techno", "House & Melodic", "Other").error).toMatch(/already/);
        expect(renameGroup(groups(), "techno", "Techno", "Other").error).toBeNull(); // its own name is fine

        expect(removeGroup(groups(), "techno").map((g) => g.id)).toEqual(["house"]);
    });

    it("locks groups that have playlists", () => {
        const s = status({
            groups: [
                {
                    id: "techno",
                    name: "Techno",
                    tracks: 3,
                    playlists: [
                        {
                            id: 1,
                            name: "Liked - Techno #1",
                            url: "https://www.beatport.com/library/playlists/1",
                            count: 3,
                            gone: false,
                        },
                    ],
                },
                { id: "house", name: "House & Melodic", tracks: 0, playlists: [] },
            ],
        });
        expect([...lockedGroups(s)]).toEqual(["techno"]);
        expect(hasPlaylists(s)).toBe(true);
        expect(hasPlaylists(status())).toBe(false);
    });
});

describe("the settings form", () => {
    const form = {
        source: "https://www.youtube.com/playlist?list=LM",
        prefix: "Liked",
        cap: "100",
        nightly: false,
        time: "04:30",
    };

    it("sends only what changed", () => {
        expect(settingsPatch(form, config())).toEqual({ patch: {}, error: null });
        expect(settingsPatch({ ...form, cap: "50", nightly: true, time: "3:15" }, config()).patch).toEqual({
            cap: 50,
            nightly: { enabled: true, hour: 3, minute: 15 },
        });
        expect(
            settingsPatch(
                { ...form, prefix: " Mine ", source: " https://music.youtube.com/playlist?list=PLx " },
                config(),
            ).patch,
        ).toEqual({
            prefix: "Mine",
            source: "https://music.youtube.com/playlist?list=PLx",
        });
    });

    it("explains what is wrong, first problem first", () => {
        const bad = (over: Partial<typeof form>) => settingsPatch({ ...form, ...over }, config()).error;
        expect(bad({ source: " " })).toMatch(/link cannot be empty/);
        expect(bad({ prefix: "" })).toMatch(/prefix/);
        expect(bad({ prefix: "a#" })).toMatch(/prefix/);
        expect(bad({ cap: "0" })).toMatch(/1 to 2000/);
        expect(bad({ cap: "2001" })).toMatch(/1 to 2000/);
        expect(bad({ cap: "1.5" })).toMatch(/whole number/);
        expect(bad({ cap: "" })).toMatch(/whole number/);
        expect(bad({ time: "25:00" })).toMatch(/hours and minutes/);
        expect(bad({ time: "noon" })).toMatch(/hours and minutes/);
    });

    it("reads times", () => {
        expect(parseTime("04:30")).toEqual({ hour: 4, minute: 30 });
        expect(parseTime(" 4.05 ")).toEqual({ hour: 4, minute: 5 });
        expect(parseTime("23:59")).toEqual({ hour: 23, minute: 59 });
        expect(parseTime("24:00")).toBeNull();
        expect(parseTime("4:5")).toBeNull();
        expect(parseTime("")).toBeNull();
    });
});

describe("the client", () => {
    const returnTo = "https://1000110.xyz/tools/#sync";
    const recording = (body: unknown = {}, status = 200, headers: Record<string, string> = {}) => {
        const calls: { url: string; init?: RequestInit }[] = [];
        const fake = (async (url: string, init?: RequestInit) => {
            calls.push({ url, init });
            return new Response(JSON.stringify(body), { status, headers });
        }) as unknown as typeof fetch;
        return { calls, api: realApi({ returnTo, fetch: fake }) };
    };

    it("asks for the status on the base path, and logs in by it (not by /health, which says 503 when broken)", async () => {
        const { calls, api } = recording({});
        await api.me();
        await api.status();
        expect(calls.map((c) => c.url)).toEqual(["/api/sc2bp/sync", "/api/sc2bp/sync"]);
        expect(calls[0].init?.method).toBe("GET");
    });

    it("starts, confirms and cancels runs", async () => {
        const { calls, api } = recording({ run: { id: "a1b2c3d4" }, created: true });
        expect(await api.start()).toEqual({ run: { id: "a1b2c3d4" }, created: true });
        await api.confirm("a1b2c3d4");
        await api.cancel("a1b2c3d4");
        expect(calls.map((c) => `${c.init?.method} ${c.url}`)).toEqual([
            "POST /api/sc2bp/sync/run",
            "POST /api/sc2bp/sync/run/a1b2c3d4/confirm",
            "POST /api/sc2bp/sync/run/a1b2c3d4/cancel",
        ]);
    });

    it("asks the inbox with its filter and paging", async () => {
        const { calls, api } = recording({ total: 0, videos: [], playlists: [] });
        await api.inbox("notfound", 50, 25);
        expect(calls[0].url).toBe("/api/sc2bp/sync/inbox?filter=notfound&offset=50&limit=25");
    });

    it("decides about a song with the right bodies, and escapes the id", async () => {
        const { calls, api } = recording({ track: { id: "v 1" } });
        await api.pick("v 1", 2004);
        await api.pick("v 1", null);
        await api.search("v 1", "better query");
        await api.setGroup("v 1", null);
        await api.skip("v 1");
        await api.restore("v 1");
        expect(calls.map((c) => c.url.replace("/api/sc2bp/sync/videos/v%201/", ""))).toEqual([
            "pick",
            "pick",
            "search",
            "group",
            "skip",
            "restore",
        ]);
        expect(calls.map((c) => c.init?.body)).toEqual([
            JSON.stringify({ id: 2004 }),
            JSON.stringify({ id: null }),
            JSON.stringify({ query: "better query" }),
            JSON.stringify({ group: null }),
            JSON.stringify({}),
            JSON.stringify({}),
        ]);
    });

    it("saves the config, imports a conversion and settles a gone playlist", async () => {
        const { calls, api } = recording({ config: { cap: 50 }, imported: 3, total: 3 });
        expect(await api.saveConfig({ cap: 50, nightly: { enabled: true } })).toEqual({ cap: 50 });
        await api.importJob("6aad4181");
        await api.resolveGone(77, "recreate");
        expect(calls.map((c) => `${c.init?.method} ${c.url} ${c.init?.body}`)).toEqual([
            `PUT /api/sc2bp/sync/config ${JSON.stringify({ cap: 50, nightly: { enabled: true } })}`,
            `POST /api/sc2bp/sync/import-job ${JSON.stringify({ jobId: "6aad4181" })}`,
            `POST /api/sc2bp/sync/gone ${JSON.stringify({ playlistId: 77, action: "recreate" })}`,
        ]);
    });

    it("turns a refusal into its message, and a 401 into the login", async () => {
        const refused = recording({ detail: "that is not one of the suggestions" }, 409);
        await expect(refused.api.pick("v1", 5)).rejects.toThrow(
            new ApiError("that is not one of the suggestions", 409),
        );
        const out = recording({}, 401, { "X-Tinyauth-Location": "https://auth.1000110.xyz/login?redirect_uri=x" });
        const error = await out.api.status().catch((e) => e);
        expect(error).toBeInstanceOf(AuthError);
        expect((error as AuthError).loginUrl).toContain("redirect_uri=https%3A%2F%2F1000110.xyz%2Ftools%2F%23sync");
    });
});

describe("addresses", () => {
    it("builds the hash of each screen", () => {
        expect(hashFor("home")).toBe("#sync");
        expect(hashFor("groups")).toBe("#sync?v=groups");
        expect(hashFor("inbox")).toBe("#sync?v=inbox");
        expect(hashFor("inbox", "notfound")).toBe("#sync?v=inbox&t=notfound");
    });
});
