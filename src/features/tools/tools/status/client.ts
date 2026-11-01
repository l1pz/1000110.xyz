import { AuthError, throwIfLoggedOut } from "../../auth";

export { AuthError };

export type Fetched = { ok: true; page: unknown; beats: unknown } | { ok: false; reason: string };

const TIMEOUT_MS = 8000;

/**
 * Same-origin GETs of Kuma's two status-page JSON files. The API is behind tinyauth, so a visitor who is not logged
 * in makes this throw `AuthError`; every other failure comes back as `{ ok: false, reason }`.
 */
export async function fetchStatus(
    returnTo: string,
    slug = "main",
    signal?: AbortSignal,
    fetchImpl: typeof fetch = (...args) => fetch(...args),
): Promise<Fetched> {
    const get = async (path: string): Promise<unknown> => {
        const timeout = AbortSignal.timeout(TIMEOUT_MS);
        const res = await fetchImpl(path, {
            credentials: "same-origin",
            redirect: "manual",
            cache: "no-store",
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        throwIfLoggedOut(res, returnTo);
        if (!res.ok) throw new Error(`the server answered ${res.status}`);
        // Before a status page exists Kuma answers with its HTML: not JSON, so this throws and is "unavailable"
        return res.json();
    };
    try {
        const [page, beats] = await Promise.all([
            get(`/api/status-page/${encodeURIComponent(slug)}`),
            get(`/api/status-page/heartbeat/${encodeURIComponent(slug)}`),
        ]);
        return { ok: true, page, beats };
    } catch (error) {
        if (error instanceof AuthError || signal?.aborted) throw error;
        return { ok: false, reason: error instanceof Error ? error.message : "cannot reach the server" };
    }
}
