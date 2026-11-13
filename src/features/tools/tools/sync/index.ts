import { loginGuard } from "../../backend-dom";
import { splitHash } from "../../state";
import type { Cleanup } from "../../types";
import { type Api, realApi } from "./api";
import type { Ctx } from "./chrome";
import { isTab } from "./model";
import { groupsView } from "./view-groups";
import { homeView } from "./view-home";
import { inboxView } from "./view-inbox";
import { runsView } from "./view-runs";
import { settingsView } from "./view-settings";

async function pickApi(): Promise<Api> {
    if (import.meta.env.DEV) return (await import("./fixtures")).fakeApi();
    return realApi({ returnTo: location.href });
}

/**
 * The tool is five screens on one hash: `#sync` (home), `#sync?v=inbox&t=<tab>`, `#sync?v=groups`, `#sync?v=settings`
 * and `#sync?v=runs`. The tools page mounts the tool again on every hash change, so this is the whole router: the
 * server holds the state, nothing needs to survive in the page.
 */
export async function mount(root: HTMLElement): Promise<Cleanup> {
    const abort = new AbortController();
    const baseTitle = document.title;
    const api = await pickApi();
    const guard = loginGuard(root, abort, "sync:login");
    if (!(await guard.enter(() => api.me(abort.signal)))) return () => abort.abort();

    const ctx: Ctx = { api, root, signal: abort.signal, auth: guard.auth, baseTitle };
    const params = splitHash(location.hash).params;
    const view = params.get("v");
    const tab = params.get("t");
    if (view === "inbox") inboxView(ctx, isTab(tab) ? tab : "review");
    else if (view === "groups") groupsView(ctx);
    else if (view === "settings") settingsView(ctx);
    else if (view === "runs") runsView(ctx);
    else homeView(ctx);

    return () => {
        abort.abort();
        document.title = baseTitle;
    };
}
