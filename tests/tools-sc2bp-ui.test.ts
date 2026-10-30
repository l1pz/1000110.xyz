import { describe, expect, it } from "vitest";
import {
    ApiError,
    AuthError,
    beatportUrl,
    chunk,
    loginUrl,
    realApi,
    searchQuery,
} from "../src/features/tools/tools/sc2bp/api";
import type { Candidate } from "../src/features/tools/tools/sc2bp/match";
import { parseTrack } from "../src/features/tools/tools/sc2bp/parse";
import {
    buildRows,
    formatTime,
    label,
    missingText,
    selectedIds,
    summary,
} from "../src/features/tools/tools/sc2bp/review";

const cand = (
    id: number,
    title: string,
    artists = ["Solomun"],
    mix = "Original Mix",
    durationSec = 400,
): Candidate => ({
    id,
    title,
    mix,
    artists,
    durationSec,
});

const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
    (async () => new Response(JSON.stringify(body), { status, headers })) as unknown as typeof fetch;

describe("chunk", () => {
    it("splits into batches", () => {
        expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
        expect(chunk([], 3)).toEqual([]);
    });
});

describe("searchQuery", () => {
    it("joins artists and title, not the mix", () => {
        expect(searchQuery(parseTrack({ title: "A & B - Song (X Remix)", uploader: "u", durationSec: null }))).toBe(
            "A B Song",
        );
    });
});

describe("loginUrl", () => {
    const header =
        "https://auth.1000110.xyz/login?login_for=app&redirect_uri=https%3A%2F%2F1000110.xyz%2Fapi%2Fsc2bp%2Fme";

    it("points the return address at the tool", () => {
        const url = new URL(loginUrl(header, "https://1000110.xyz/tools/#sc2bp") ?? "");
        expect(url.origin).toBe("https://auth.1000110.xyz");
        expect(url.searchParams.get("redirect_uri")).toBe("https://1000110.xyz/tools/#sc2bp");
        expect(url.searchParams.get("login_for")).toBe("app");
    });

    it("gives null for a missing or odd header", () => {
        expect(loginUrl(null, "x")).toBeNull();
        expect(loginUrl("not a url", "x")).toBeNull();
        expect(loginUrl("javascript:alert(1)", "x")).toBeNull();
    });
});

describe("beatportUrl", () => {
    it("allows https links on beatport.com only", () => {
        expect(beatportUrl("https://www.beatport.com/library/playlists/1")).toBe(
            "https://www.beatport.com/library/playlists/1",
        );
        expect(beatportUrl("https://beatport.com.evil.example/x")).toBeNull();
        expect(beatportUrl("http://www.beatport.com/x")).toBeNull();
        expect(beatportUrl("javascript:alert(1)")).toBeNull();
        expect(beatportUrl(null)).toBeNull();
    });
});

describe("realApi", () => {
    const returnTo = "https://1000110.xyz/tools/#sc2bp";

    it("turns a 401 into an AuthError carrying the login address", async () => {
        const api = realApi({
            returnTo,
            fetch: reply(401, {}, { "X-Tinyauth-Location": "https://auth.1000110.xyz/login?redirect_uri=x" }),
        });
        const error = await api.me().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(AuthError);
        expect((error as AuthError).loginUrl).toContain("redirect_uri=https%3A%2F%2F1000110.xyz%2Ftools%2F%23sc2bp");
    });

    it("shows the server's detail text for other errors", async () => {
        const api = realApi({ returnTo, fetch: reply(502, { detail: "yt-dlp failed" }) });
        const error = await api.playlist("https://soundcloud.com/a/sets/b").catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ApiError);
        expect((error as Error).message).toBe("yt-dlp failed");
    });

    it("falls back to the status when there is no detail", async () => {
        const api = realApi({ returnTo, fetch: reply(500, "boom") });
        await expect(api.me()).rejects.toThrow("the server answered 500");
    });

    it("posts JSON to the right path", async () => {
        const calls: { url: string; init?: RequestInit }[] = [];
        const api = realApi({
            returnTo,
            fetch: (async (url: string, init?: RequestInit) => {
                calls.push({ url, init });
                return new Response(JSON.stringify({ results: [[]] }));
            }) as unknown as typeof fetch,
        });
        await api.search(["a b"]);
        expect(calls[0].url).toBe("/api/sc2bp/search");
        expect(calls[0].init?.method).toBe("POST");
        expect(calls[0].init?.body).toBe(JSON.stringify({ queries: ["a b"] }));
    });

    it("reads tracks in the order of the links and checks the count", async () => {
        const track = { title: "A - B", uploader: "A", durationSec: 1 };
        const urls = ["https://soundcloud.com/a/1", "https://soundcloud.com/a/2"];
        const ok = realApi({ returnTo, fetch: reply(200, { tracks: [track, track] }) });
        expect(await ok.tracks(urls)).toHaveLength(2);
        const short = realApi({ returnTo, fetch: reply(200, { tracks: [track] }) });
        await expect(short.tracks(urls)).rejects.toThrow("wrong number");
    });

    it("rejects a search answer of the wrong length", async () => {
        const api = realApi({ returnTo, fetch: reply(200, { results: [] }) });
        await expect(api.search(["a"])).rejects.toThrow("wrong number");
    });
});

describe("review", () => {
    const tracks = [
        { title: "Solomun - Higher State", uploader: "u", durationSec: 400 },
        { title: "Someone - Almost Right", uploader: "u", durationSec: 300 },
        { title: "Nobody - Nothing Here", uploader: "u", durationSec: 200 },
    ];
    const found = [[cand(1, "Higher State")], [cand(2, "Almost Right", ["Other Person"], "Original Mix", 300)], []];
    const rows = buildRows(tracks, found);

    it("picks a match at once and leaves a maybe to the visitor", () => {
        expect(rows.map((r) => r.result.verdict)).toEqual(["match", "maybe", "none"]);
        expect(rows.map((r) => r.picked)).toEqual([1, null, null]);
    });

    it("counts rows and picks", () => {
        expect(summary(rows)).toEqual({ match: 1, maybe: 1, none: 1, selected: 1 });
        rows[1].picked = 2;
        expect(summary(rows).selected).toBe(2);
        rows[1].picked = null;
    });

    it("adds a Beatport track picked twice only once", () => {
        const twice = buildRows([tracks[0], tracks[0]], [[cand(1, "Higher State")], [cand(1, "Higher State")]]);
        expect(selectedIds(twice)).toEqual([1]);
    });

    it("lists what has no pick", () => {
        expect(missingText(rows)).toBe("Someone - Almost Right\nNobody - Nothing Here");
    });

    it("labels a track with its mix", () => {
        expect(label(parseTrack({ title: "A - B (C Remix)", uploader: "u", durationSec: null }))).toBe(
            "A - B (C Remix)",
        );
    });

    it("formats times", () => {
        expect(formatTime(365)).toBe("6:05");
        expect(formatTime(59.6)).toBe("1:00");
        expect(formatTime(null)).toBe("?");
    });
});
