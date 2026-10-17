/**
 * Tool state: shareable links and remembered options. Pure (storage is passed in), so tests call it directly.
 * The hash is `#<id>` or `#<id>?k=v&k=v`. Options are remembered in localStorage; typed text never is, it only
 * travels in a link the user copies on purpose.
 */

/** Longest single value that goes into a link; longer text is left out and reported. */
export const LINK_LIMIT = 4000;

/** Where "send to another tool" parks the text for the next tool to pick up. */
export const PIPE_KEY = "tools:pipe";

/** The part of `Storage` this module needs; `null` stands for "storage is blocked". */
export type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Splits `#id?k=v` into the tool id and its query parameters. */
export function splitHash(hash: string): { id: string; params: URLSearchParams } {
    const raw = hash.replace(/^#/, "");
    const cut = raw.indexOf("?");
    const id = cut === -1 ? raw : raw.slice(0, cut);
    const query = cut === -1 ? "" : raw.slice(cut + 1);
    let decoded = id;
    try {
        decoded = decodeURIComponent(id);
    } catch {
        // a malformed escape: keep the raw id, it will simply not match a tool
    }
    return { id: decoded, params: new URLSearchParams(query) };
}

/** `#id?k=v...` for the values worth sharing; empty values and values over `LINK_LIMIT` are left out (the latter are listed). */
export function buildHash(id: string, values: Record<string, string>): { hash: string; dropped: string[] } {
    const params = new URLSearchParams();
    const dropped: string[] = [];
    for (const [key, value] of Object.entries(values)) {
        if (value === "") continue;
        if (value.length > LINK_LIMIT) dropped.push(key);
        else params.set(key, value);
    }
    const query = params.toString();
    return { hash: `#${encodeURIComponent(id)}${query ? `?${query}` : ""}`, dropped };
}

/** Parks text for the next tool. Returns false when storage is blocked. */
export function putPipe(store: Store | null, text: string): boolean {
    try {
        store?.setItem(PIPE_KEY, text);
        return store !== null;
    } catch {
        return false;
    }
}

/** Takes the parked text (once) or `null`. */
export function takePipe(store: Store | null): string | null {
    try {
        const text = store?.getItem(PIPE_KEY) ?? null;
        if (text !== null) store?.removeItem(PIPE_KEY);
        return text;
    } catch {
        return null;
    }
}

/** Anything with a `.value`: a textarea, an input, or a stand-in in tests. */
export interface TextBox {
    value: string;
}

export type Allowed = readonly string[] | ((value: string) => boolean);

export interface ToolState {
    /** URL value, else remembered value, else `fallback`; a value that is not `allowed` is skipped. Also feeds the link. */
    get(key: string, fallback: string, allowed?: Allowed): string;
    /** Like `get`, as a whole number clamped to `[min, max]`. */
    getNumber(key: string, fallback: number, min: number, max: number): number;
    /** Remembers an option (localStorage) and updates the link. */
    set(key: string, value: string): void;
    /** Fills the box from the URL (or, for the `primary` box, from a "send to" handoff) and puts its text in the link. `share: false` keeps secrets out of links. */
    bindText(key: string, box: TextBox, options?: { primary?: boolean; share?: boolean }): void;
    /** The `#id?...` hash that reproduces the current state, and the keys that were too long to include. */
    link(): { hash: string; dropped: string[] };
}

/**
 * State for one tool. `hash` is `location.hash` at mount time, `local` is localStorage, `session` is
 * sessionStorage (for the "send to" handoff). Either store may be `null`.
 */
export function createToolState(id: string, hash: string, local: Store | null, session: Store | null): ToolState {
    const { params } = splitHash(hash);
    const options: Record<string, string> = {};
    const boxes: Record<string, TextBox> = {};
    let pipe: string | null | undefined;

    const remembered = (key: string): string | null => {
        try {
            return local?.getItem(`tools:${id}:${key}`) ?? null;
        } catch {
            return null;
        }
    };
    const ok = (value: string | null, allowed?: Allowed): value is string =>
        value !== null && (!allowed || (typeof allowed === "function" ? allowed(value) : allowed.includes(value)));

    const get = (key: string, fallback: string, allowed?: Allowed): string => {
        const fromUrl = params.get(key);
        const fromStore = remembered(key);
        const value = ok(fromUrl, allowed) ? fromUrl : ok(fromStore, allowed) ? fromStore : fallback;
        options[key] = value;
        return value;
    };

    return {
        get,
        getNumber(key, fallback, min, max) {
            const n = Math.round(
                Number(get(key, String(fallback), (v) => v.trim() !== "" && Number.isFinite(Number(v)))),
            );
            const value = Math.min(max, Math.max(min, n));
            options[key] = String(value);
            return value;
        },
        set(key, value) {
            options[key] = value;
            try {
                local?.setItem(`tools:${id}:${key}`, value);
            } catch {
                // blocked or full: the option just is not remembered
            }
        },
        bindText(key, box, { primary = false, share = true } = {}) {
            if (primary && pipe === undefined) pipe = takePipe(session);
            const fromUrl = params.get(key);
            if (primary && pipe != null) {
                box.value = pipe;
                pipe = null;
            } else if (fromUrl !== null) box.value = fromUrl;
            if (share) boxes[key] = box;
        },
        link() {
            const values = { ...options };
            for (const [key, box] of Object.entries(boxes)) values[key] = box.value;
            return buildHash(id, values);
        },
    };
}
