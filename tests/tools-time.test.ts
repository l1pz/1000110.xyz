import { describe, expect, it } from "vitest";
import { formatInZone, isValidZone, parseInput, rows } from "../src/features/tools/tools/time/time";

const NOW = 1_700_000_000_000;

describe("parseInput", () => {
    it("is empty for empty input", () => {
        expect(parseInput("  ", NOW)).toBe("");
    });

    it("reads now", () => {
        expect(parseInput("NOW", NOW)).toMatchObject({ ms: NOW });
    });

    it("tells seconds from milliseconds", () => {
        expect(parseInput("1700000000", NOW)).toMatchObject({ ms: NOW, note: "read as unix seconds" });
        expect(parseInput("1700000000000", NOW)).toMatchObject({ ms: NOW, note: "read as unix milliseconds" });
        expect(parseInput("-86400", NOW)).toMatchObject({ ms: -86_400_000 });
        expect(parseInput("1700000000.5", NOW)).toMatchObject({ ms: NOW + 500 });
    });

    it("reads date strings", () => {
        expect(parseInput("2023-11-14T22:13:20Z", NOW)).toMatchObject({ ms: NOW, note: "read as a date" });
        expect(parseInput("2023-11-14T23:13:20+01:00", NOW)).toMatchObject({ ms: NOW });
        expect(parseInput("2023-11-14", NOW)).toMatchObject({ note: "read as a date" });
        expect(parseInput("2023-11-14T22:13:20", NOW)).toMatchObject({
            note: "read as a date in your local time zone",
        });
    });

    it("rejects junk and out of range numbers", () => {
        expect(parseInput("hello", NOW)).toMatch(/not a timestamp/);
        expect(parseInput("99999999999999999999", NOW)).toBe("out of range");
    });
});

describe("zones", () => {
    it("validates IANA names", () => {
        expect(isValidZone("Europe/Budapest")).toBe(true);
        expect(isValidZone("UTC")).toBe(true);
        expect(isValidZone("Mars/Olympus")).toBe(false);
    });

    it("formats with the offset", () => {
        expect(formatInZone(NOW, "UTC")).toBe("2023-11-14 22:13:20 +00:00");
        expect(formatInZone(NOW, "Europe/Budapest")).toBe("2023-11-14 23:13:20 +01:00");
        expect(formatInZone(NOW, "Asia/Kolkata")).toBe("2023-11-15 03:43:20 +05:30");
    });

    it("follows daylight saving time", () => {
        const summer = Date.UTC(2024, 6, 1, 12, 0, 0);
        expect(formatInZone(summer, "Europe/Budapest")).toBe("2024-07-01 14:00:00 +02:00");
        expect(formatInZone(summer, "America/New_York")).toBe("2024-07-01 08:00:00 -04:00");
    });

    it("uses 00 for midnight, not 24", () => {
        expect(formatInZone(Date.UTC(2024, 0, 1, 0, 0, 0), "UTC")).toBe("2024-01-01 00:00:00 +00:00");
    });
});

describe("rows", () => {
    it("lists unix, iso and zones, skipping unknown zones", () => {
        const r = rows(NOW, ["UTC", "Nope/Nowhere"]);
        expect(r.map(([l]) => l)).toEqual(["unix seconds", "unix millis", "iso 8601", "UTC"]);
        expect(r[0][1]).toBe("1700000000");
        expect(r[2][1]).toBe("2023-11-14T22:13:20.000Z");
    });
});
