import { describe, expect, it } from "vitest";
import {
    ApiError,
    AuthError,
    beatportUrl,
    browserLoginUrl,
    type Candidate,
    type Job,
    loginUrl,
    NetworkError,
    realApi,
    soundcloudUrl,
} from "../src/features/tools/tools/sc2bp/api";
import {
    actionsFor,
    ago,
    barText,
    candidateText,
    duration,
    fallbackName,
    formatTime,
    noticeFor,
    overall,
    phaseText,
    pollDelay,
    progressBar,
    resultModel,
    reviewTabs,
    rowModel,
    sortJobs,
    stateMark,
    tabTitle,
    waitingText,
} from "../src/features/tools/tools/sc2bp/jobs";

const job = (over: Partial<Job> = {}): Job => ({
    id: "a1b2c3d4",
    name: "Techno",
    url: "https://soundcloud.com/u/sets/techno",
    state: "running",
    phase: "matching",
    created: 1000,
    updated: 1100,
    total: 400,
    progress: { phase: "matching", done: 200, total: 400 },
    counts: { match: 0, maybe: 0, none: 0, error: 0, unreadable: 0, picked: 0, added: 0 },
    needsReview: 0,
    pendingPicks: 0,
    waiting: null,
    error: null,
    playlist: null,
    ...over,
});

const done = (counts: Partial<Job["counts"]> = {}, over: Partial<Job> = {}): Job =>
    job({
        state: "done",
        phase: "finished",
        progress: { phase: "finished", done: 1, total: 1 },
        counts: { match: 372, maybe: 6, none: 20, error: 0, unreadable: 2, picked: 372, added: 372, ...counts },
        needsReview: 26,
        ...over,
    });

describe("progress", () => {
    it("draws a bar of blocks and shades", () => {
        expect(progressBar(0)).toBe(`[${"░".repeat(20)}]`);
        expect(progressBar(0.5)).toBe(`[${"█".repeat(10)}${"░".repeat(10)}]`);
        expect(progressBar(1)).toBe(`[${"█".repeat(20)}]`);
        expect(progressBar(0.5, 10)).toBe("[█████░░░░░]");
    });

    it("never overflows the bar", () => {
        expect(progressBar(7)).toBe(`[${"█".repeat(20)}]`);
        expect(progressBar(-1)).toBe(`[${"░".repeat(20)}]`);
    });

    it("moves forward through the phases, never back", () => {
        const at = (phase: Job["progress"]["phase"], done: number, total: number) =>
            overall(job({ phase, progress: { phase, done, total } }));
        const steps = [
            at("listing", 0, 0),
            at("reading", 0, 400),
            at("reading", 200, 400),
            at("matching", 0, 400),
            at("matching", 200, 400),
            at("matching", 400, 400),
            at("creating", 0, 300),
            at("creating", 150, 300),
        ];
        expect(steps).toEqual([...steps].sort((a, b) => a - b));
        expect(steps[0]).toBe(0);
        expect(at("matching", 200, 400)).toBeCloseTo(0.03 + 0.27 + 0.3, 5);
    });

    it("is complete for a finished job and tolerates an empty phase", () => {
        expect(overall(done())).toBe(1);
        expect(overall(job({ phase: "reading", progress: { phase: "reading", done: 0, total: 0 } }))).toBeCloseTo(
            0.03,
            5,
        );
    });

    it("shows the bar with a percentage", () => {
        expect(barText(job())).toBe(`${progressBar(0.6)} 60%`);
        // floating-point noise must not cost a percent: 0.03 + 0.27 + 0.6 * 0.5 is 0.6, not 0.5999
        expect(barText(job({ progress: { phase: "matching", done: 400, total: 800 } }))).toContain("60%");
    });

    it("says what the phase is doing", () => {
        const text = (phase: Job["progress"]["phase"], done = 5, total = 9) =>
            phaseText(job({ progress: { phase, done, total } }));
        expect(text("listing")).toBe("reading the playlist");
        expect(text("reading")).toBe("reading tracks 5/9");
        expect(text("matching")).toBe("matching on Beatport 5/9");
        expect(text("creating")).toBe("adding to the playlist 5/9");
        expect(text("finished")).toBe("finishing");
    });
});

describe("words and marks", () => {
    it("marks each state", () => {
        expect(stateMark("queued")).toEqual({ text: "[..]", tone: "idle" });
        expect(stateMark("running")).toEqual({ text: "[>>]", tone: "run" });
        expect(stateMark("paused")).toEqual({ text: "[||]", tone: "warn" });
        expect(stateMark("failed")).toEqual({ text: "[!!]", tone: "bad" });
        expect(stateMark("cancelled")).toEqual({ text: "[--]", tone: "idle" });
        expect(stateMark("done")).toEqual({ text: "[ok]", tone: "ok" });
    });

    it("formats durations and ages", () => {
        expect([duration(4), duration(59.6), duration(60), duration(185), duration(3600), duration(3900)]).toEqual([
            "4s",
            "1m",
            "1m",
            "3m",
            "1h 00m",
            "1h 05m",
        ]);
        expect(ago(1000, 1005)).toBe("just now");
        expect(ago(1000, 1180)).toBe("3m ago");
        expect(duration(-5)).toBe("0s");
    });

    it("names a job that has no name yet by its link", () => {
        expect(fallbackName("https://soundcloud.com/user/sets/name/")).toBe("soundcloud.com/user/sets/name");
        expect(fallbackName("https://www.soundcloud.com/x")).toBe("soundcloud.com/x");
    });

    it("counts down a retry", () => {
        expect(waitingText(null, 100)).toBeNull();
        expect(waitingText({ until: 140.2, reason: "Beatport answered 503" }, 100)).toBe(
            "retrying in 41s (Beatport answered 503)",
        );
        expect(waitingText({ until: 90, reason: "x" }, 100)).toBe("retrying in 0s (x)");
    });

    it("formats times and suggestions", () => {
        expect(formatTime(365)).toBe("6:05");
        expect(formatTime(59.6)).toBe("1:00");
        expect(formatTime(null)).toBe("?");
        const c: Candidate = {
            id: 1,
            title: "Song ",
            mix: "Dixon Remix",
            artists: ["A", "B"],
            durationSec: 301,
            score: 0.7,
        };
        expect(candidateText(c)).toBe("Song (Dixon Remix) · A, B · 5:01");
        expect(candidateText({ ...c, mix: "", durationSec: null })).toBe("Song · A, B · ?");
    });
});

describe("a job row", () => {
    const now = 1180;

    it("shows a running job with its phase, age and bar", () => {
        const row = rowModel(job(), now);
        expect(row.mark.tone).toBe("run");
        expect(row.name).toBe("Techno");
        expect(row.info).toBe("matching on Beatport 200/400 · started 3m ago");
        expect(row.bar).toBe(barText(job()));
    });

    it("shows the retry countdown instead of the phase while waiting", () => {
        const row = rowModel(job({ waiting: { until: 1200, reason: "Beatport answered 429" } }), now);
        expect(row.info).toContain("retrying in 20s (Beatport answered 429)");
    });

    it("shows a queued job without a bar", () => {
        const row = rowModel(job({ state: "queued" }), now);
        expect(row.info).toBe("waiting in the queue · added 3m ago");
        expect(row.bar).toBeNull();
    });

    it("shows why a job stopped", () => {
        const error = { message: "Beatport refused the login", phase: "matching" as const };
        expect(rowModel(job({ state: "failed", error }), now).info).toBe("stopped: Beatport refused the login");
        const paused = rowModel(job({ state: "paused", error }), now);
        expect(paused.info).toBe("paused: Beatport refused the login");
        expect(paused.bar).not.toBeNull();
        expect(rowModel(job({ state: "cancelled", counts: { ...job().counts, added: 12 } }), now).info).toContain(
            "12 added",
        );
    });

    it("shows the result of a finished job", () => {
        expect(rowModel(done(), now).info).toBe("372 of 400 added · 26 to review · 1m ago");
        expect(rowModel(done({}, { needsReview: 0 }), now).info).toBe("372 of 400 added · 1m ago");
        expect(rowModel(done(), now).bar).toBeNull();
    });

    it("uses the link as the name when the job has none yet", () => {
        expect(rowModel(job({ name: "" }), now).name).toBe("soundcloud.com/u/sets/techno");
    });
});

describe("the list of jobs", () => {
    const j = (id: string, state: Job["state"], created: number) => job({ id, state, created });

    it("puts running jobs first, then the ones that need the owner, newest first inside each", () => {
        const sorted = sortJobs([
            j("done-old", "done", 1),
            j("failed", "failed", 5),
            j("running", "running", 3),
            j("done-new", "done", 9),
            j("queued", "queued", 4),
            j("paused", "paused", 6),
        ]);
        expect(sorted.map((x) => x.id)).toEqual(["queued", "running", "paused", "failed", "done-new", "done-old"]);
    });

    it("does not change the list it is given", () => {
        const input = [j("a", "done", 1), j("b", "running", 2)];
        sortJobs(input);
        expect(input.map((x) => x.id)).toEqual(["a", "b"]);
    });

    it("counts running jobs in the tab title, or hints that one needs the owner", () => {
        expect(tabTitle([j("a", "running", 1), j("b", "queued", 2), j("c", "done", 3)], "tool")).toBe(
            "(2 running) tool",
        );
        expect(tabTitle([j("a", "failed", 1)], "tool")).toBe("(needs you) tool");
        expect(tabTitle([j("a", "done", 1)], "tool")).toBe("tool");
        expect(tabTitle([], "tool")).toBe("tool");
    });

    it("asks often while something runs and rarely otherwise, and even less when the tab is hidden", () => {
        const running = [j("a", "running", 1)];
        const quiet = [j("a", "done", 1), j("b", "paused", 2)];
        expect(pollDelay(running, false)).toBe(3_000);
        expect(pollDelay(quiet, false)).toBe(20_000);
        expect(pollDelay(running, true)).toBe(15_000);
        expect(pollDelay(quiet, true)).toBe(60_000);
        expect(pollDelay([], false)).toBe(20_000);
    });
});

describe("the buttons a job gets", () => {
    const ids = (j: Job) => actionsFor(j).map((a) => a.id);

    it("can only be cancelled while it runs", () => {
        expect(ids(job({ state: "running" }))).toEqual(["cancel"]);
        expect(ids(job({ state: "queued" }))).toEqual(["cancel"]);
    });

    it("can be retried or deleted when it stopped", () => {
        expect(ids(job({ state: "paused" }))).toEqual(["retry", "delete"]);
        expect(ids(job({ state: "failed" }))).toEqual(["retry", "delete"]);
        expect(actionsFor(job({ state: "cancelled" }))[0].label).toBe("resume");
    });

    it("offers the review, the picked tracks and a retry of errors on a finished job, in that order of use", () => {
        expect(ids(done({}, { needsReview: 0 }))).toEqual(["delete"]);
        expect(ids(done())).toEqual(["review", "delete"]);
        expect(ids(done({ error: 3 }))).toEqual(["retry", "review", "delete"]);
        const picked = actionsFor(done({}, { pendingPicks: 4 }));
        expect(picked.map((a) => a.id)).toEqual(["apply", "review", "delete"]);
        expect(picked[0].label).toBe("add 4 picked to the playlist");
        expect(actionsFor(done({ error: 3 }))[0].label).toBe("retry 3 that hit an error");
    });
});

describe("what to tell the owner", () => {
    it("explains a stop and what to do about it", () => {
        const error = { message: "Beatport refused the login", phase: "matching" as const };
        expect(noticeFor(job({ state: "failed", error }))).toEqual({
            tone: "bad",
            text: "stopped: Beatport refused the login. This needs you: fix the cause, then retry.",
        });
        expect(noticeFor(job({ state: "paused", error }))?.text).toContain("Nothing is lost");
        expect(noticeFor(job({ state: "cancelled" }))?.tone).toBe("idle");
        expect(noticeFor(job({ state: "running" }))).toBeNull();
        expect(noticeFor(done())).toBeNull();
    });

    it("sums up a finished job and leaves out the empty lines", () => {
        expect(resultModel(done())).toEqual({
            headline: "372 of 400 tracks are in your Beatport playlist",
            lines: ["not found on Beatport: 20", "found, but not sure: 6", "could not be read (private or deleted): 2"],
        });
        expect(resultModel(done({ none: 0, maybe: 0, unreadable: 0, error: 4 })).lines).toEqual(["hit an error: 4"]);
        expect(resultModel(done({ added: 0, match: 0, none: 0, maybe: 0, unreadable: 0 }))).toEqual({
            headline: "nothing was added to Beatport",
            lines: [],
        });
    });

    it("offers the review tabs that have something in them, and the one being looked at", () => {
        const j = done({ none: 20, maybe: 6, error: 0, unreadable: 2 });
        expect(reviewTabs(j, "unmatched").map((t) => t.filter)).toEqual(["unmatched", "maybe", "none", "unreadable"]);
        expect(reviewTabs(j, "error").map((t) => t.filter)).toContain("error");
        expect(reviewTabs(done({ none: 0, maybe: 0, unreadable: 0 }, { needsReview: 0 }), "unmatched")).toEqual([
            { filter: "unmatched", label: "not matched" },
        ]);
    });
});

describe("links", () => {
    it("points the login's return address at the tool", () => {
        const header =
            "https://auth.1000110.xyz/login?login_for=app&redirect_uri=https%3A%2F%2F1000110.xyz%2Fapi%2Fsc2bp%2Fme";
        const url = new URL(loginUrl(header, "https://1000110.xyz/tools/#sc2bp?j=a1b2c3d4") ?? "");
        expect(url.origin).toBe("https://auth.1000110.xyz");
        expect(url.searchParams.get("redirect_uri")).toBe("https://1000110.xyz/tools/#sc2bp?j=a1b2c3d4");
        expect(loginUrl(null, "x")).toBeNull();
        expect(loginUrl("not a url", "x")).toBeNull();
        expect(loginUrl("javascript:alert(1)", "x")).toBeNull();
    });

    it("shows only https links on the expected site as links", () => {
        expect(beatportUrl("https://www.beatport.com/library/playlists/1")).toBe(
            "https://www.beatport.com/library/playlists/1",
        );
        expect(beatportUrl("https://beatport.com.evil.example/x")).toBeNull();
        expect(beatportUrl("http://www.beatport.com/x")).toBeNull();
        expect(beatportUrl("javascript:alert(1)")).toBeNull();
        expect(beatportUrl(null)).toBeNull();
        expect(soundcloudUrl("https://soundcloud.com/a/b")).toBe("https://soundcloud.com/a/b");
        expect(soundcloudUrl("https://www.beatport.com/x")).toBeNull();
    });
});

describe("the client", () => {
    const returnTo = "https://1000110.xyz/tools/#sc2bp";
    const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
        (async () => new Response(JSON.stringify(body), { status, headers })) as unknown as typeof fetch;

    function recording(body: unknown) {
        const calls: { url: string; init?: RequestInit }[] = [];
        const fetch = (async (url: string, init?: RequestInit) => {
            calls.push({ url, init });
            return new Response(JSON.stringify(body));
        }) as unknown as typeof globalThis.fetch;
        return { api: realApi({ returnTo, fetch }), calls };
    }

    it("starts a job with a JSON body", async () => {
        const { api, calls } = recording({ job: job(), created: true });
        const result = await api.start("https://soundcloud.com/a/sets/b", "Mine");
        expect(result.created).toBe(true);
        expect(calls[0].url).toBe("/api/sc2bp/jobs");
        expect(calls[0].init?.method).toBe("POST");
        expect(calls[0].init?.body).toBe(JSON.stringify({ url: "https://soundcloud.com/a/sets/b", name: "Mine" }));
    });

    it("lists and reads jobs", async () => {
        expect(await recording({ jobs: [job()] }).api.list()).toHaveLength(1);
        const { api, calls } = recording({ job: job() });
        expect((await api.get("a1b2c3d4")).id).toBe("a1b2c3d4");
        expect(calls[0].url).toBe("/api/sc2bp/jobs/a1b2c3d4");
        expect(calls[0].init?.method).toBe("GET");
    });

    it("asks for a page of tracks", async () => {
        const { api, calls } = recording({ total: 0, tracks: [] });
        await api.tracks("a1b2c3d4", "maybe", 25, 25);
        expect(calls[0].url).toBe("/api/sc2bp/jobs/a1b2c3d4/tracks?filter=maybe&offset=25&limit=25");
    });

    it("cancels, retries, applies, deletes, picks and searches with the right verbs and paths", async () => {
        const { api, calls } = recording({ job: job(), track: { index: 3 } });
        await api.cancel("a1b2c3d4");
        await api.retry("a1b2c3d4");
        await api.apply("a1b2c3d4");
        await api.remove("a1b2c3d4");
        await api.pick("a1b2c3d4", 3, 77);
        await api.pick("a1b2c3d4", 3, null);
        await api.search("a1b2c3d4", 3, "artist title");
        expect(calls.map((c) => `${c.init?.method} ${c.url}`)).toEqual([
            "POST /api/sc2bp/jobs/a1b2c3d4/cancel",
            "POST /api/sc2bp/jobs/a1b2c3d4/retry",
            "POST /api/sc2bp/jobs/a1b2c3d4/apply",
            "DELETE /api/sc2bp/jobs/a1b2c3d4",
            "POST /api/sc2bp/jobs/a1b2c3d4/tracks/3/pick",
            "POST /api/sc2bp/jobs/a1b2c3d4/tracks/3/pick",
            "POST /api/sc2bp/jobs/a1b2c3d4/tracks/3/search",
        ]);
        expect(calls[4].init?.body).toBe(JSON.stringify({ id: 77 }));
        expect(calls[5].init?.body).toBe(JSON.stringify({ id: null }));
        expect(calls[6].init?.body).toBe(JSON.stringify({ query: "artist title" }));
    });

    it("never lets an odd job id change the path", async () => {
        const { api, calls } = recording({ job: job() });
        await api.get("../../etc");
        expect(calls[0].url).toBe("/api/sc2bp/jobs/..%2F..%2Fetc");
    });

    it("turns a 401 into an AuthError carrying the login address", async () => {
        const api = realApi({
            returnTo,
            fetch: reply(401, {}, { "X-Tinyauth-Location": "https://auth.1000110.xyz/login?redirect_uri=x" }),
        });
        const error = await api.me().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(AuthError);
        expect((error as AuthError).loginUrl).toContain("redirect_uri=https%3A%2F%2F1000110.xyz%2Ftools%2F%23sc2bp");
    });

    it("turns the redirect a browser gets into an AuthError with a login address built from the site", async () => {
        const calls: (RequestInit | undefined)[] = [];
        const fetch = (async (_url: string, init?: RequestInit) => {
            calls.push(init);
            return { type: "opaqueredirect", status: 0, ok: false } as unknown as Response;
        }) as unknown as typeof globalThis.fetch;
        const error = await realApi({ returnTo, fetch })
            .me()
            .catch((e: unknown) => e);
        expect(calls[0]?.redirect).toBe("manual");
        expect(error).toBeInstanceOf(AuthError);
        const url = new URL((error as AuthError).loginUrl ?? "");
        expect(url.origin).toBe("https://auth.1000110.xyz");
        expect(url.pathname).toBe("/login");
        expect(url.searchParams.get("login_for")).toBe("app");
        expect(url.searchParams.get("redirect_uri")).toBe(returnTo);
    });

    it("builds no login address away from an https site", () => {
        expect(browserLoginUrl("http://localhost:5173/tools/#sc2bp")).toBeNull();
        expect(browserLoginUrl("not a url")).toBeNull();
        expect(browserLoginUrl("https://www.1000110.xyz/tools/")).toContain("https://auth.1000110.xyz/login");
    });

    it("keeps the server's explanation and status for other errors", async () => {
        const api = realApi({ returnTo, fetch: reply(404, { detail: "no such job or track" }) });
        const error = await api.get("a1b2c3d4").catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).message).toBe("no such job or track");
        expect((error as ApiError).status).toBe(404);
    });

    it("falls back to the status line when there is no explanation", async () => {
        const api = realApi({ returnTo, fetch: reply(500, "boom") });
        await expect(api.me()).rejects.toThrow("the server answered 500");
    });

    it("says so when the server cannot be reached, but not when the caller left", async () => {
        const offline = realApi({
            returnTo,
            fetch: (async () => {
                throw new TypeError("Failed to fetch");
            }) as unknown as typeof fetch,
        });
        await expect(offline.me()).rejects.toBeInstanceOf(NetworkError);

        const controller = new AbortController();
        controller.abort();
        const aborted = realApi({
            returnTo,
            fetch: (async () => {
                throw new DOMException("aborted", "AbortError");
            }) as unknown as typeof fetch,
        });
        const error = await aborted.me(controller.signal).catch((e: unknown) => e);
        expect(error).not.toBeInstanceOf(NetworkError);
    });
});
