import type { Cleanup } from "../../types";
import { button, buttonRow, lineInput, linkButton, statusLine, toolState } from "../../ui";
import { type Api, AuthError, beatportUrl, chunk, realApi, SEARCH_BATCH, searchQuery, TRACK_BATCH } from "./api";
import type { Scored } from "./match";
import { parseTrack, type SoundCloudTrack } from "./parse";
import { buildRows, formatTime, label, missingText, type Row, selectedIds, summary } from "./review";

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

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ""): HTMLElementTagNameMap[K] {
    const n = document.createElement(tag);
    n.className = className;
    n.textContent = text;
    return n;
}

function describe(s: Scored): string {
    const { candidate: c } = s;
    const mix = c.mix ? ` (${c.mix})` : "";
    return `${c.title}${mix} · ${c.artists.join(", ")} · ${formatTime(c.durationSec)}`;
}

export async function mount(root: HTMLElement): Promise<Cleanup> {
    const abort = new AbortController();
    const api = await pickApi();
    const state = toolState("sc2bp");
    const status = statusLine();
    const form = node("div", "");
    root.append(form, status.node);

    // Not logged in: go to the login page (once), and come back to this tool.
    try {
        await api.me(abort.signal);
        flag("clear");
    } catch (error) {
        form.hidden = true;
        if (error instanceof AuthError && error.loginUrl && !flag("get")) {
            flag("set");
            status.set("logging in...");
            location.assign(error.loginUrl);
        } else if (error instanceof AuthError) {
            flag("clear");
            status.set("not logged in, and the login did not stick. reload to try again", true);
        } else if (!abort.signal.aborted) {
            status.set(error instanceof Error ? error.message : "could not reach the server", true);
        }
        return () => abort.abort();
    }

    const url = lineInput("soundcloud playlist url", "https://soundcloud.com/user/sets/name");
    state.bindText("u", url.input);
    const name = lineInput("beatport playlist name");
    const list = node("div", "tracks");
    const result = node("p", "status");
    let rows: Row[] = [];
    let skipped = 0;
    let busy = false;

    const fetchBtn = button("fetch tracks", () => void run());
    const createBtn = button("create playlist", () => void create());
    const missingBtn = button("copy missing", () => {
        void navigator.clipboard.writeText(missingText(rows)).then(
            () => status.set("copied the tracks without a pick"),
            () => status.set("the browser blocked the clipboard", true),
        );
    });
    const afterFetch = buttonRow(createBtn, missingBtn);
    const refreshers: (() => void)[] = [];

    function updateSummary(): void {
        const s = summary(rows);
        const unread = skipped > 0 ? `. ${skipped} could not be read` : "";
        status.set(
            `${rows.length} tracks: ${s.match} match, ${s.maybe} maybe, ${s.none} not found. ${s.selected} picked${unread}`,
        );
        createBtn.textContent = `create playlist (${s.selected})`;
        createBtn.disabled = busy || s.selected === 0;
    }

    function setBusy(on: boolean): void {
        busy = on;
        fetchBtn.disabled = on;
        createBtn.disabled = on || selectedIds(rows).length === 0;
    }

    function fail(error: unknown): void {
        if (abort.signal.aborted) return;
        if (error instanceof AuthError) status.set("your login ran out. reload the page to log in again", true);
        else status.set(error instanceof Error ? error.message : "something went wrong", true);
    }

    function block(row: Row): HTMLElement {
        const box = node("div", "trk");
        const head = node("p", "trk-head");
        const mark = node("span", "mark");
        head.append(mark, label(row.parsed));
        box.append(head);

        const buttons: [HTMLButtonElement, number][] = row.result.ranked.map((scored) => {
            const b = button("", () => {
                row.picked = row.picked === scored.candidate.id ? null : scored.candidate.id;
                refreshers.forEach((r) => {
                    r();
                });
                updateSummary();
            });
            b.classList.add("cand");
            b.append(describe(scored), node("span", "dim", ` ${Math.round(scored.score * 100)}%`));
            return [b, scored.candidate.id];
        });

        const refresh = () => {
            const picked = row.picked !== null;
            mark.textContent = picked ? "[+]" : row.result.verdict === "none" ? "[-]" : "[?]";
            mark.className = `mark ${picked ? "ok" : row.result.verdict === "none" ? "none" : "maybe"}`;
            for (const [b, id] of buttons) b.classList.toggle("active", id === row.picked);
        };
        refreshers.push(refresh);

        if (buttons.length === 0) {
            box.append(node("p", "dim", "not found on beatport"));
        } else if (row.result.verdict === "match") {
            // A confident hit shows only itself; the rest is one tap away.
            const [first, ...others] = buttons;
            const more = node("div", "more");
            more.hidden = true;
            more.append(...others.map(([b]) => b));
            const toggle = button(`other results (${others.length})`, () => {
                more.hidden = !more.hidden;
            });
            toggle.classList.add("link");
            box.append(first[0]);
            if (others.length > 0) box.append(toggle, more);
        } else {
            box.append(...buttons.map(([b]) => b));
        }
        refresh();
        return box;
    }

    function render(): void {
        refreshers.length = 0;
        list.replaceChildren(...rows.map(block));
        afterFetch.hidden = name.wrap.hidden = rows.length === 0;
        updateSummary();
    }

    async function run(): Promise<void> {
        const link = url.input.value.trim();
        if (!link) return status.set("paste a soundcloud playlist link first", true);
        setBusy(true);
        rows = [];
        render();
        result.replaceChildren();
        try {
            status.set("reading the playlist...");
            const playlist = await api.playlist(link, abort.signal);
            const read: SoundCloudTrack[] = [];
            for (const batch of chunk(playlist.urls, TRACK_BATCH)) {
                status.set(`reading tracks... ${read.length}/${playlist.urls.length}`);
                read.push(...(await api.tracks(batch, abort.signal)));
            }
            const tracks = read.filter((t) => t.title.trim() !== "");
            skipped = read.length - tracks.length;
            if (tracks.length === 0) throw new Error("none of the tracks could be read (private or deleted?)");
            const found = [];
            const queries = tracks.map((t) => searchQuery(parseTrack(t)));
            for (const batch of chunk(queries, SEARCH_BATCH)) {
                status.set(`searching beatport... ${found.length}/${queries.length}`);
                found.push(...(await api.search(batch, abort.signal)));
            }
            rows = buildRows(tracks, found);
            if (!name.input.value) name.input.value = playlist.name;
            render();
        } catch (error) {
            fail(error);
        } finally {
            setBusy(false);
        }
    }

    async function create(): Promise<void> {
        const ids = selectedIds(rows);
        const title = name.input.value.trim();
        if (ids.length === 0) return;
        if (!title) return status.set("give the playlist a name", true);
        setBusy(true);
        status.set("creating the playlist...");
        try {
            const made = await api.create(title, ids, abort.signal);
            status.set(`created "${made.name}" with ${made.added} tracks`);
            const href = beatportUrl(made.url);
            if (href) {
                const a = node("a", "", "open on beatport");
                a.href = href;
                a.target = "_blank";
                a.rel = "noopener noreferrer";
                result.replaceChildren(a);
            }
        } catch (error) {
            fail(error);
        } finally {
            setBusy(false);
        }
    }

    afterFetch.hidden = name.wrap.hidden = true;
    form.append(url.wrap, buttonRow(fetchBtn, linkButton(state)), list, name.wrap, afterFetch, result);
    return () => abort.abort();
}
