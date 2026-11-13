import { candidateText, formatTime } from "../../backend";
import { describe, external, h, link, tone } from "../../backend-dom";
import { button, buttonRow, statusLine } from "../../ui";
import { type Candidate, type GonePlaylist, type InboxFilter, type Row, type Status, sourcePage } from "./api";
import { type Ctx, hashFor, navBar } from "./chrome";
import { EMPTY_TEXT, groupName, inboxTabs, rowNote } from "./model";

const PAGE = 25;
/** `#sync?v=inbox&t=<tab>`: the songs that need a decision, 25 at a time, and the playlists that vanished. */
export function inboxView(ctx: Ctx, initial: InboxFilter): void {
    const { api, root, signal } = ctx;
    const tabs = h("div", "buttons");
    const count = h("p", "dim");
    const list = h("div", "tracks");
    const more = button("show more", () => void load(true));
    const status = statusLine();
    const nav = h("div");
    root.append(h("h2", "jobname", "inbox"), tabs, count, list, buttonRow(more), status.node, nav);

    let info: Status | null = null;
    let filter = initial;
    let shown = 0;
    let total = 0;
    let loading = false;

    const fail = (error: unknown, into = status) => {
        if (signal.aborted || ctx.auth(error)) return;
        into.set(describe(error), true);
    };

    async function refresh(): Promise<void> {
        try {
            info = await api.status(signal);
            drawTabs();
            nav.replaceChildren(navBar("inbox", info.counts));
        } catch (error) {
            fail(error);
        }
    }

    function drawTabs(): void {
        if (!info) return;
        const buttons = inboxTabs(info.counts, filter).map((t) => {
            const b = button(`${t.label} (${t.count})`, () => {
                if (t.filter === filter) return;
                filter = t.filter;
                history.replaceState(null, "", hashFor("inbox", filter));
                drawTabs();
                void load(false);
            });
            b.classList.toggle("active", t.filter === filter);
            return b;
        });
        tabs.replaceChildren(...buttons);
    }

    /** One liked song: its suggestions as buttons, a place to search Beatport by hand, and what to do with it. */
    function rowBlock(initialRow: Row): HTMLElement {
        let row = initialRow;
        const box = h("div", "trk");
        let searching = false;
        let searchOpen = false;
        let moving = false;
        const note = statusLine();
        note.node.className = "dim trknote";

        const run = async (call: () => Promise<Row>, removes = false) => {
            try {
                row = await call();
                if (removes) {
                    box.replaceChildren(
                        h("p", "dim", `${row.label}: ${row.status === "skipped" ? "skipped" : "back in the queue"}`),
                    );
                } else draw();
                await refresh();
            } catch (error) {
                fail(error, note);
            }
        };

        const search = async (query: string) => {
            if (!query.trim()) return note.set("type something to search for", true);
            searching = true;
            note.set("searching...");
            draw();
            try {
                row = await api.search(row.id, query, signal);
                note.set(row.candidates.length ? "" : "nothing found for that search");
                await refresh();
            } catch (error) {
                fail(error, note);
            } finally {
                searching = false;
                draw();
            }
        };

        function suggestion(c: Candidate): HTMLButtonElement {
            const b = button("", () => void run(() => api.pick(row.id, row.picked === c.id ? null : c.id, signal)));
            b.classList.add("cand");
            b.classList.toggle("active", row.picked === c.id);
            b.disabled = searching;
            b.append(
                candidateText(c),
                h("span", "dim", ` ${Math.round(c.score * 100)}%`),
                h("span", "dim", c.genre ? ` · ${c.genre}` : ""),
            );
            return b;
        }

        function groupPicker(): HTMLElement {
            const groups = [
                ...(info?.config.groups ?? []),
                { id: "other", name: info?.config.otherName ?? "Other", genres: [] },
            ];
            const wrap = h("div", "buttons");
            for (const g of groups) {
                const b = button(g.name, () => {
                    moving = false;
                    void run(() => api.setGroup(row.id, g.id, signal));
                });
                b.classList.toggle("active", row.group === g.id);
                wrap.append(b);
            }
            if (row.groupOverride) {
                wrap.append(
                    button("back to automatic", () => {
                        moving = false;
                        void run(() => api.setGroup(row.id, null, signal));
                    }),
                );
            }
            return wrap;
        }

        function draw(): void {
            const parts: HTMLElement[] = [];
            const head = h("p", "trk-head");
            const bad = row.status === "notfound" || row.status === "unreadable" || row.status === "unavailable";
            head.append(
                row.picked !== null ? tone("[+]", "ok") : bad ? tone("[-]", "bad") : tone("[?]", "warn"),
                row.label,
            );
            if (row.durationSec !== null) head.append(h("span", "dim", ` ${formatTime(row.durationSec)}`));
            parts.push(head);
            const page = sourcePage(row.url);
            const hint = rowNote(row, Date.now() / 1000);
            if (hint || page) {
                const p = h("p", "dim", hint ? `${hint} ` : "");
                if (page) p.append(external("open on youtube", page.url));
                parts.push(p);
            }
            if (row.error) parts.push(h("p", "error", row.error));

            if (row.status === "skipped") {
                parts.push(buttonRow(button("bring it back", () => void run(() => api.restore(row.id, signal), true))));
                box.replaceChildren(...parts, note.node);
                return;
            }
            if (row.status !== "unreadable") {
                parts.push(...row.candidates.map(suggestion));
                if (row.candidates.length === 0 && !searchOpen) parts.push(h("p", "dim", "no suggestions"));
                if (row.picked !== null) {
                    const where = h(
                        "p",
                        "dim",
                        `will be added on the next sync, to ${groupName(info?.config.groups ?? [], row.group)}${row.genre ? ` (${row.genre})` : ""} `,
                    );
                    const change = button(moving ? "hide groups" : "put it in another group", () => {
                        moving = !moving;
                        draw();
                    });
                    change.classList.add("link");
                    where.append(change);
                    parts.push(where);
                    if (moving) parts.push(groupPicker());
                }
                const links = h("div", "rowlinks");
                if (searchOpen) {
                    const input = h("input");
                    input.type = "text";
                    input.value = row.query;
                    input.spellcheck = false;
                    input.setAttribute("aria-label", "search Beatport");
                    const go = button(searching ? "searching..." : "search", () => void search(input.value));
                    go.disabled = searching;
                    input.addEventListener("keydown", (e) => {
                        if (e.key === "Enter") void search(input.value);
                    });
                    const sb = h("div", "searchbox");
                    sb.append(input, go);
                    parts.push(sb);
                } else {
                    const open = button("search Beatport by hand", () => {
                        searchOpen = true;
                        draw();
                    });
                    open.classList.add("link");
                    links.append(open);
                }
                const skip = button("skip it for good", () => void run(() => api.skip(row.id, signal), true));
                skip.classList.add("link");
                links.append(skip);
                parts.push(links);
            }
            box.replaceChildren(...parts, note.node);
        }

        draw();
        return box;
    }

    /** A playlist the sync made that is no longer on Beatport. */
    function goneBlock(p: GonePlaylist): HTMLElement {
        const box = h("div", "trk");
        const note = statusLine();
        note.node.className = "dim trknote";
        let confirming = false;
        const decide = async (action: "recreate" | "forget") => {
            try {
                await api.resolveGone(p.id, action, signal);
                box.replaceChildren(
                    h(
                        "p",
                        "dim",
                        `${p.name}: ${action === "recreate" ? "its songs will be added again on the next sync" : "its songs are left out"}`,
                    ),
                );
                await refresh();
            } catch (error) {
                fail(error, note);
            }
        };
        function draw(): void {
            const forget = button(confirming ? "really leave them out?" : "leave its songs out", () => {
                if (!confirming) {
                    confirming = true;
                    draw();
                    setTimeout(() => {
                        confirming = false;
                        if (box.isConnected) draw();
                    }, 4000);
                    return;
                }
                void decide("forget");
            });
            box.replaceChildren(
                h("p", "trk-head", `${p.name} is gone from Beatport (${p.tracks} songs were in it)`),
                buttonRow(
                    button("add its songs again", () => void decide("recreate")),
                    forget,
                ),
                note.node,
            );
        }
        draw();
        return box;
    }

    async function load(append: boolean): Promise<void> {
        if (loading) return;
        loading = true;
        more.disabled = true;
        if (!append) {
            shown = 0;
            list.replaceChildren(h("p", "dim", "(loading...)"));
            count.textContent = "";
        }
        try {
            const page = await api.inbox(filter, shown, PAGE, signal);
            total = page.total;
            if (!append) list.replaceChildren();
            const nodes = filter === "gone" ? page.playlists.map(goneBlock) : page.videos.map(rowBlock);
            shown += nodes.length;
            list.append(...nodes);
            count.textContent = total === 0 ? "" : `${shown} of ${total} shown`;
            if (total === 0) list.replaceChildren(h("p", "dim", `(${EMPTY_TEXT[filter]})`));
        } catch (error) {
            if (!append) list.replaceChildren();
            fail(error);
        } finally {
            loading = false;
            more.hidden = shown >= total;
            more.disabled = false;
            more.textContent = `show more (${Math.max(0, total - shown)} left)`;
        }
    }

    more.hidden = true;
    void refresh().then(() => load(false));
    root.prepend(link("< home", hashFor("home"), "back"));
}
