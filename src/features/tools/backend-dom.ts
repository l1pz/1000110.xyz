/** DOM helpers shared by the tools that talk to the `sc2bp` service. Styles are in `styles/tools.css`. */
import { AuthError } from "./auth";
import { ApiError, NetworkError, type Tone } from "./backend";

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
}

/** A link inside the tool (`#sc2bp?j=...`): the hash router remounts the tool on every hash change. */
export function link(text: string, href: string, className = ""): HTMLAnchorElement {
    const a = h("a", className, text);
    a.href = href;
    return a;
}

/** An external link: new tab, no referrer. */
export function external(text: string, href: string): HTMLAnchorElement {
    const a = link(text, href);
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
}

export function tone(text: string, kind: Tone, className = "mark"): HTMLSpanElement {
    return h("span", `${className} ${kind}`, text);
}

/** What to tell the visitor about a failed call. */
export function describe(error: unknown): string {
    if (error instanceof NetworkError) return "cannot reach the server, trying again...";
    if (error instanceof ApiError) return error.message;
    return error instanceof Error ? error.message : "something went wrong";
}

/**
 * Runs `tick` now and again after the delay it returns, until `signal` aborts. It also runs at once when the tab
 * becomes visible again, because a hidden tab asks rarely. `tick` handles its own errors; a surprise retries in 10 s.
 */
export function startPolling(tick: () => Promise<number>, signal: AbortSignal): { now(): void } {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    const later = (ms: number) => {
        clearTimeout(timer);
        if (!signal.aborted) timer = setTimeout(() => void run(), ms);
    };
    const run = async () => {
        if (busy || signal.aborted) return;
        busy = true;
        try {
            later(await tick());
        } catch {
            later(10_000);
        } finally {
            busy = false;
        }
    };
    const visible = () => {
        if (!document.hidden) void run();
    };
    document.addEventListener("visibilitychange", visible);
    signal.addEventListener("abort", () => {
        clearTimeout(timer);
        document.removeEventListener("visibilitychange", visible);
    });
    void run();
    return {
        now() {
            clearTimeout(timer);
            void run();
        },
    };
}

/**
 * The login handling every tool behind tinyauth needs: when a call says "not logged in", go to the login page once and
 * come back; if the login does not stick, say so instead of looping. `key` names the sessionStorage flag that remembers
 * the one try.
 */
export function loginGuard(root: HTMLElement, abort: AbortController, key: string) {
    const flag = (action: "get" | "set" | "clear"): boolean => {
        try {
            if (action === "set") sessionStorage.setItem(key, "1");
            if (action === "clear") sessionStorage.removeItem(key);
            return sessionStorage.getItem(key) === "1";
        } catch {
            return false;
        }
    };
    const stopped = (message: string, error = true) => {
        abort.abort();
        root.replaceChildren(h("p", error ? "error" : "dim", message));
    };
    /** For a failed call: if it was about the login, takes over and returns true. */
    const auth = (error: unknown): boolean => {
        if (!(error instanceof AuthError)) return false;
        if (error.loginUrl && !flag("get")) {
            flag("set");
            stopped("logging in...", false);
            location.assign(error.loginUrl);
        } else {
            flag("clear");
            stopped("not logged in, and the login did not stick. reload to try again");
        }
        return true;
    };
    /** Resolves true when the visitor is logged in and the tool may start. */
    const enter = async (me: () => Promise<void>): Promise<boolean> => {
        try {
            await me();
            flag("clear");
            return true;
        } catch (error) {
            if (!abort.signal.aborted && !auth(error)) stopped(describe(error));
            return false;
        }
    };
    return { auth, enter, stopped };
}
