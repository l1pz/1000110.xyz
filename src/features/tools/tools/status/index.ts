import type { Cleanup } from "../../types";
import { AuthError, fetchStatus } from "./client";
import { overall, parseStatus } from "./parse";
import { reportHtml, unavailableHtml } from "./view";

const REFRESH_MS = 60_000;
/** Set just before going to the login page, so a login that does not stick shows an error instead of looping. */
const LOGIN_FLAG = "status:login";

function flag(action: "get" | "set" | "clear"): boolean {
    try {
        if (action === "set") sessionStorage.setItem(LOGIN_FLAG, "1");
        if (action === "clear") sessionStorage.removeItem(LOGIN_FLAG);
        return sessionStorage.getItem(LOGIN_FLAG) === "1";
    } catch {
        return false;
    }
}

/** In `npm run dev` the saved real Kuma responses stand in for the server. */
async function devFetch(): Promise<typeof fetch> {
    const [page, beats] = await Promise.all([
        import("../../../../../tests/fixtures/kuma/status-page.json"),
        import("../../../../../tests/fixtures/kuma/heartbeat.json"),
    ]);
    // The saved beats are old: move them so the newest one is a few seconds ago (else everything shows as stale).
    const shifted = structuredClone(beats.default) as { heartbeatList: Record<string, { time: string }[]> };
    const all = Object.values(shifted.heartbeatList).flat();
    const newest = Math.max(...all.map((b) => Date.parse(`${b.time.replace(" ", "T")}Z`)));
    for (const b of all) {
        const t = Date.parse(`${b.time.replace(" ", "T")}Z`) + (Date.now() - 5000 - newest);
        b.time = new Date(t).toISOString().replace("T", " ").replace("Z", "");
    }
    return async (input) => {
        const body = String(input).includes("heartbeat") ? shifted : page.default;
        return new Response(JSON.stringify(body), { status: 200 });
    };
}

export async function mount(root: HTMLElement): Promise<Cleanup> {
    const abort = new AbortController();
    const out = document.createElement("div");
    out.innerHTML = '<p class="dim">loading...</p>';
    root.replaceChildren(out);
    const fetchImpl = import.meta.env.DEV ? await devFetch() : undefined;
    let lastOk: number | null = null;

    const loggedOut = (error: AuthError) => {
        abort.abort();
        if (error.loginUrl && !flag("get")) {
            flag("set");
            out.innerHTML = '<p class="dim">logging in...</p>';
            location.assign(error.loginUrl);
        } else {
            flag("clear");
            out.innerHTML = '<p class="error">not logged in, and the login did not stick. reload to try again</p>';
        }
    };

    const refresh = async () => {
        const now = Date.now();
        let html: string;
        try {
            const got = await fetchStatus(location.href, "main", abort.signal, fetchImpl);
            flag("clear");
            const report = got.ok ? parseStatus(got.page, got.beats) : null;
            if (report) {
                lastOk = now;
                html = reportHtml(report, overall(report, now), now);
            } else {
                html = unavailableHtml(got.ok ? "unexpected answer from the monitor" : got.reason, lastOk);
            }
        } catch (error) {
            if (abort.signal.aborted) return;
            if (error instanceof AuthError) return loggedOut(error);
            html = unavailableHtml("cannot reach the server", lastOk);
        }
        if (!abort.signal.aborted) out.innerHTML = html;
    };

    const onVisible = () => {
        if (document.visibilityState === "visible") void refresh();
    };
    await refresh();
    const timer = setInterval(onVisible, REFRESH_MS);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
        abort.abort();
        clearInterval(timer);
        document.removeEventListener("visibilitychange", onVisible);
    };
}
