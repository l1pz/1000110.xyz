import { describe, expect, it } from "vitest";
import { AuthError } from "../src/features/tools/auth";
import { fetchStatus } from "../src/features/tools/tools/status/client";
import { beatTime, lastBeats, monitorNow, overall, parseStatus } from "../src/features/tools/tools/status/parse";
import {
    BAR_LENGTH,
    barText,
    fitName,
    monitorRow,
    reportHtml,
    unavailableHtml,
    uptimeText,
} from "../src/features/tools/tools/status/view";
import beatsFixture from "./fixtures/kuma/heartbeat.json";
import pageFixture from "./fixtures/kuma/status-page.json";

type Beats = { heartbeatList: Record<string, { status: number }[]>; uptimeList: Record<string, unknown> };
const copyBeats = () => structuredClone(beatsFixture) as unknown as Beats;
const setLast = (b: Beats, id: string, status: number) => {
    const list = b.heartbeatList[id];
    list[list.length - 1].status = status;
};
/** One minute after the newest beat in the fixture. */
const NOW = (beatTime("2026-10-31 20:07:26.046") ?? 0) + 60_000;

describe("parseStatus", () => {
    it("reads the real Kuma answer", () => {
        const report = parseStatus(pageFixture, beatsFixture);
        expect(report?.groups.map((g) => [g.name, g.monitors.length])).toEqual([
            ["services", 5],
            ["sites", 3],
            ["games", 1],
        ]);
        const first = report?.groups[0].monitors[0];
        expect(first?.name).toBe("website");
        expect(first?.uptime).toBe(1);
        expect(first?.beats.every((b) => b === "up")).toBe(true);
    });

    it("reads Kuma's UTC beat time", () => {
        expect(beatTime("2026-10-31 20:07:26.046")).toBe(Date.UTC(2026, 9, 31, 20, 7, 26, 46));
        expect(beatTime("nonsense")).toBeNull();
    });

    it("maps down, maintenance and unknown beat codes", () => {
        const beats = copyBeats();
        setLast(beats, "1", 0);
        setLast(beats, "2", 3);
        setLast(beats, "3", 99);
        const [a, b, c] = parseStatus(pageFixture, beats)?.groups[0].monitors ?? [];
        expect(a.beats.at(-1)).toBe("down");
        expect(b.beats.at(-1)).toBe("maintenance");
        expect(c.beats.at(-1)).toBe("none");
    });

    it("keeps a monitor that has no heartbeats, with no data", () => {
        const beats = copyBeats();
        delete beats.heartbeatList["4"];
        const m = parseStatus(pageFixture, beats)?.groups[0].monitors[3];
        expect(m?.beats).toEqual([]);
        expect(m && monitorNow(m, NOW)).toBe("none");
    });

    it("has no uptime when Kuma gives none or nonsense", () => {
        const beats = copyBeats();
        delete beats.uptimeList["1_24"];
        beats.uptimeList["2_24"] = 7;
        const ms = parseStatus(pageFixture, beats)?.groups[0].monitors;
        expect(ms?.[0].uptime).toBeNull();
        expect(ms?.[1].uptime).toBeNull();
    });

    it.each([
        ["HTML text", "<!DOCTYPE html>", "<!DOCTYPE html>"],
        ["null", null, null],
        ["no groups", {}, beatsFixture],
        ["empty groups", { publicGroupList: [] }, beatsFixture],
        ["a group without a name", { publicGroupList: [{ monitorList: [] }] }, beatsFixture],
        ["no heartbeat list", pageFixture, {}],
        ["a heartbeat list that is an array", pageFixture, { heartbeatList: [] }],
        ["beats that are not a list", pageFixture, { heartbeatList: { "1": "up" } }],
        ["a beat without a status", pageFixture, { heartbeatList: { "1": [{ time: "2026-10-31 20:00:00.000" }] } }],
    ])("rejects a wrong shape: %s", (_name, page, beats) => {
        expect(parseStatus(page, beats)).toBeNull();
    });
});

describe("states", () => {
    const report = parseStatus(pageFixture, beatsFixture);

    it("says all systems operational when everything beats up", () => {
        expect(report && overall(report, NOW)).toEqual({ kind: "ok", text: "all systems operational" });
    });

    it("counts down monitors", () => {
        const beats = copyBeats();
        setLast(beats, "1", 0);
        setLast(beats, "5", 0);
        const r = parseStatus(pageFixture, beats);
        expect(r && overall(r, NOW)).toEqual({ kind: "down", text: "2 of 9 down" });
    });

    it("never shows old beats as live: no beat for five minutes is stale", () => {
        const later = NOW + 10 * 60_000;
        const first = report?.groups[0].monitors[0];
        expect(first && monitorNow(first, later)).toBe("stale");
        expect(report && overall(report, later)).toEqual({ kind: "warn", text: "9 of 9 not reporting" });
    });

    it("pads the bar on the left and cuts it to the last beats", () => {
        expect(lastBeats(["up", "down"], 4)).toEqual(["none", "none", "up", "down"]);
        expect(lastBeats(Array(30).fill("up"), 3)).toEqual(["up", "up", "up"]);
        expect(barText(["up", "down", "pending"])).toBe(`${"·".repeat(BAR_LENGTH - 3)}█▒░`);
    });
});

describe("view", () => {
    it("fits a row into 41 columns (name 14, bar 20, uptime 5)", () => {
        const m = parseStatus(pageFixture, beatsFixture)?.groups[1].monitors[1];
        const text = (m ? monitorRow(m, NOW) : "").replace(/<[^>]+>/g, "");
        expect(text).toHaveLength(14 + 1 + BAR_LENGTH + 1 + 5);
        expect(text.startsWith("jarmisutode.h…")).toBe(true);
    });

    it("formats names and uptime", () => {
        expect(fitName("web")).toBe("web".padEnd(14));
        expect(uptimeText(null)).toBe("--");
        expect(uptimeText(1)).toBe("100%");
        expect(uptimeText(0.9995)).toBe("100%");
        expect(uptimeText(0.9912)).toBe("99.1%");
    });

    it("escapes names from Kuma", () => {
        const r = parseStatus(pageFixture, beatsFixture);
        if (!r) throw new Error("fixture");
        r.groups[0].name = "<b>x</b>";
        expect(reportHtml(r, overall(r, NOW), NOW)).not.toContain("<b>x</b>");
    });

    it("shows only the reason, never bars, when unavailable", () => {
        const html = unavailableHtml("the server answered 502", null);
        expect(html).toContain("status unavailable");
        expect(html).not.toContain("█");
    });
});

describe("fetchStatus", () => {
    const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    const fake = (route: (url: string) => Response) =>
        ((url: string) => Promise.resolve(route(String(url)))) as unknown as typeof fetch;
    const back = "https://1000110.xyz/tools/#status";

    it("fetches both files and returns the JSON", async () => {
        const urls: string[] = [];
        const got = await fetchStatus(
            back,
            "main",
            undefined,
            fake((u) => {
                urls.push(u);
                return ok(u.includes("heartbeat") ? beatsFixture : pageFixture);
            }),
        );
        expect(urls.sort()).toEqual(["/api/status-page/heartbeat/main", "/api/status-page/main"]);
        expect(got.ok && parseStatus(got.page, got.beats)).not.toBeNull();
    });

    it("throws AuthError with the login address on 401", async () => {
        const f = fake(
            () =>
                new Response("", {
                    status: 401,
                    headers: { "X-Tinyauth-Location": "https://auth.1000110.xyz/login?redirect_uri=x" },
                }),
        );
        const error = await fetchStatus(back, "main", undefined, f).catch((e) => e);
        expect(error).toBeInstanceOf(AuthError);
        expect(error.loginUrl).toContain("redirect_uri=https%3A%2F%2F1000110.xyz%2Ftools%2F%23status");
    });

    it("reports Kuma's HTML (no status page yet) as unavailable", async () => {
        const f = fake(() => new Response("<!DOCTYPE html><html></html>", { status: 200 }));
        expect((await fetchStatus(back, "main", undefined, f)).ok).toBe(false);
    });

    it("reports a server error and a lost connection as unavailable", async () => {
        const e502 = await fetchStatus(
            back,
            "main",
            undefined,
            fake(() => new Response("", { status: 502 })),
        );
        expect(e502).toEqual({ ok: false, reason: "the server answered 502" });
        const lost = await fetchStatus(back, "main", undefined, (() =>
            Promise.reject(new TypeError("offline"))) as typeof fetch);
        expect(lost.ok).toBe(false);
    });
});
