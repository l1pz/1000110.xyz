import { describe, external, h, link, startPolling, tone } from "../../backend-dom";
import type { Api } from "./api";

export { describe, external, h, link, startPolling, tone };

/** Shared by the three screens. */
export interface Ctx {
    api: Api;
    root: HTMLElement;
    /** Aborted when the visitor leaves the tool: every request and timer stops with it. */
    signal: AbortSignal;
    /** For a failed call: if it was about the login, takes over (goes to the login page, or says so) and returns true. */
    auth(error: unknown): boolean;
    /** The page title without the `(n running)` prefix. */
    baseTitle: string;
}

export const jobLink = (id: string, review = false): string => `#sc2bp?j=${id}${review ? "&r=1" : ""}`;
