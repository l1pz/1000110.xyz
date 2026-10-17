/** Numbers with at least this many digits-worth of size are read as milliseconds (1e11 s is year 5138, 1e11 ms is 1973). */
const MS_THRESHOLD = 1e11;

/** Largest time a JS Date can hold, in milliseconds. */
const MAX_MS = 8.64e15;

export interface Parsed {
    ms: number;
    /** How the input was read, shown under the box. */
    note: string;
}

/** Reads `now`, unix seconds, unix milliseconds or a date string. Returns an error message (empty for empty input) otherwise. */
export function parseInput(text: string, nowMs: number): Parsed | string {
    const t = text.trim();
    if (t === "") return "";
    if (t.toLowerCase() === "now") return { ms: Math.floor(nowMs), note: "now" };
    if (/^-?\d+(\.\d+)?$/.test(t)) {
        const n = Number(t);
        const isMs = Math.abs(n) >= MS_THRESHOLD;
        const ms = Math.round(isMs ? n : n * 1000);
        if (Math.abs(ms) > MAX_MS) return "out of range";
        return { ms, note: isMs ? "read as unix milliseconds" : "read as unix seconds" };
    }
    const ms = Date.parse(t);
    if (Number.isNaN(ms)) return "not a timestamp or date (try 1700000000 or 2024-03-10T12:00:00Z)";
    const hasZone = /(?:z|[+-]\d{2}:?\d{2}|gmt|utc)$/i.test(t) || /^\d{4}-\d{2}-\d{2}$/.test(t);
    return { ms, note: hasZone ? "read as a date" : "read as a date in your local time zone" };
}

export function isValidZone(zone: string): boolean {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: zone });
        return true;
    } catch {
        return false;
    }
}

/** `2024-03-10 12:00:00 +01:00` for `ms` in the IANA zone `zone`. */
export function formatInZone(ms: number, zone: string): string {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
        timeZoneName: "longOffset",
    }).formatToParts(new Date(ms));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
    // longOffset gives "GMT" for zero and "GMT+01:00" otherwise
    const offset = get("timeZoneName").replace("GMT", "") || "+00:00";
    const date = `${get("year")}-${get("month")}-${get("day")}`;
    return `${date} ${get("hour")}:${get("minute")}:${get("second")} ${offset}`;
}

export function localZone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/** Zones shown by default, besides the local one. */
export const DEFAULT_ZONES = ["UTC", "Europe/Budapest", "America/New_York", "Asia/Tokyo"];

/** The rows shown to the user: label and value. `zones` that Intl does not know are skipped. */
export function rows(ms: number, zones: readonly string[]): [string, string][] {
    const out: [string, string][] = [
        ["unix seconds", String(Math.floor(ms / 1000))],
        ["unix millis", String(ms)],
        ["iso 8601", new Date(ms).toISOString()],
    ];
    for (const zone of zones) if (isValidZone(zone)) out.push([zone, formatInZone(ms, zone)]);
    return out;
}
