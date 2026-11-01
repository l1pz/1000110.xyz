/** Login handling shared by the tools that call a tinyauth-protected API (sc2bp, status). */

/** The server refused: not logged in. `loginUrl` is where to go, when the server said. */
export class AuthError extends Error {
    constructor(readonly loginUrl: string | null) {
        super("not logged in");
    }
}

/**
 * tinyauth answers a browser (by its User-Agent) with a `302` to its login page instead, and a script cannot read where
 * it points. So the address is built here: tinyauth lives on `auth.` next to the site. `null` away from a real site.
 */
export function browserLoginUrl(returnTo: string): string | null {
    try {
        const site = new URL(returnTo);
        if (site.protocol !== "https:") return null;
        const url = new URL(`https://auth.${site.hostname.replace(/^www\./, "")}/login`);
        url.searchParams.set("login_for", "app");
        url.searchParams.set("redirect_uri", returnTo);
        return url.toString();
    } catch {
        return null;
    }
}

/**
 * tinyauth answers an unauthenticated script call with `401` and its login address in `X-Tinyauth-Location`, whose
 * `redirect_uri` points at the API call. Points it back at `returnTo` (this tool) instead; `null` for anything odd.
 */
export function loginUrl(header: string | null, returnTo: string): string | null {
    if (!header) return null;
    try {
        const url = new URL(header);
        if (url.protocol !== "https:" && url.protocol !== "http:") return null;
        if (url.searchParams.has("redirect_uri")) url.searchParams.set("redirect_uri", returnTo);
        return url.toString();
    } catch {
        return null;
    }
}

/** Throws `AuthError` when `res` is tinyauth's answer to a visitor who is not logged in; otherwise does nothing. */
export function throwIfLoggedOut(res: Response, returnTo: string): void {
    if (res.type === "opaqueredirect") throw new AuthError(browserLoginUrl(returnTo));
    if (res.status === 401 || res.status === 403) {
        throw new AuthError(loginUrl(res.headers.get("X-Tinyauth-Location"), returnTo));
    }
}
