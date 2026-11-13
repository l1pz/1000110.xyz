import { h, link } from "../../backend-dom";
import type { Api, Counts, InboxFilter } from "./api";

/** The screens of the tool. */
export type View = "home" | "inbox" | "groups" | "settings" | "runs";

/** Shared by every screen. */
export interface Ctx {
    api: Api;
    root: HTMLElement;
    /** Aborted when the visitor leaves the tool: every request and timer stops with it. */
    signal: AbortSignal;
    /** For a failed call: if it was about the login, takes over (goes to the login page, or says so) and returns true. */
    auth(error: unknown): boolean;
    /** The page title without the `(syncing)` prefix. */
    baseTitle: string;
}

/** `#sync`, `#sync?v=inbox`, `#sync?v=inbox&t=notfound`: the tools page remounts the tool on every hash change. */
export function hashFor(view: View, tab?: InboxFilter): string {
    if (view === "home") return "#sync";
    return `#sync?v=${view}${tab ? `&t=${tab}` : ""}`;
}

const LABELS: Record<Exclude<View, "home">, string> = {
    inbox: "inbox",
    groups: "groups",
    settings: "settings",
    runs: "history",
};

/** The row of links under every screen; the current one is not a link. `needYou` shows on the inbox. */
export function navBar(current: View, counts?: Counts | null): HTMLElement {
    const bar = h("nav", "syncnav");
    const items: [View, string][] = [["home", "home"], ...(Object.entries(LABELS) as [View, string][])];
    for (const [view, label] of items) {
        const text = view === "inbox" && counts && counts.needYou > 0 ? `${label} (${counts.needYou})` : label;
        if (view === current) bar.append(h("span", "current", text));
        else bar.append(link(text, hashFor(view)));
    }
    return bar;
}
