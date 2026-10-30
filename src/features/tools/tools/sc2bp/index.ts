import { splitHash } from "../../state";
import type { Cleanup } from "../../types";
import { type Api, AuthError, realApi } from "./api";
import { type Ctx, describe, h } from "./dom";
import { jobView } from "./view-job";
import { mainView } from "./view-main";
import { reviewView } from "./view-review";

/** Set just before going to the login page, so a login that does not stick shows an error instead of looping. */
const LOGIN_FLAG = "sc2bp:login";

function flag(action: "get" | "set" | "clear"): boolean {
    try {
        if (action === "set") sessionStorage.setItem(LOGIN_FLAG, "1");
        if (action === "clear") sessionStorage.removeItem(LOGIN_FLAG);
        return sessionStorage.getItem(LOGIN_FLAG) === "1";
    } catch {
        return false;
    }
}

async function pickApi(): Promise<Api> {
    if (import.meta.env.DEV) return (await import("./fixtures")).fakeApi();
    return realApi({ returnTo: location.href });
}

const JOB_ID = /^[0-9a-f]{8}$/;

/**
 * The tool is three screens on one hash: `#sc2bp` (new job and the list of jobs), `#sc2bp?j=<id>` (one job) and
 * `#sc2bp?j=<id>&r=1` (the optional review). The tools page mounts the tool again on every hash change, so this is
 * the whole router: the server holds the state, nothing needs to survive in the page.
 */
export async function mount(root: HTMLElement): Promise<Cleanup> {
    const abort = new AbortController();
    const baseTitle = document.title;
    const api = await pickApi();

    const stopped = (message: string, error = true) => {
        abort.abort();
        root.replaceChildren(h("p", error ? "error" : "dim", message));
    };

    // Not logged in: go to the login page (once), and come back to this tool.
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

    try {
        await api.me(abort.signal);
        flag("clear");
    } catch (error) {
        if (!abort.signal.aborted && !auth(error)) stopped(describe(error));
        return () => abort.abort();
    }

    const ctx: Ctx = { api, root, signal: abort.signal, auth, baseTitle };
    const params = splitHash(location.hash).params;
    const id = params.get("j") ?? "";
    if (!JOB_ID.test(id)) mainView(ctx);
    else if (params.get("r") === "1") reviewView(ctx, id);
    else jobView(ctx, id);

    return () => {
        abort.abort();
        document.title = baseTitle;
    };
}
