import { button, buttonRow, statusLine } from "../../ui";
import { ApiError, type Filter, type Job, soundcloudUrl, type Track } from "./api";
import { type Ctx, describe, external, h, jobLink, link, tone } from "./dom";
import { candidateText, fallbackName, formatTime, reviewTabs } from "./jobs";

const PAGE = 25;

/** `#sc2bp?j=<id>&r=1`: the optional look at the tracks nothing was picked for, 25 at a time. */
export function reviewView(ctx: Ctx, id: string): void {
    const { api, root, signal } = ctx;
    const heading = h("h2", "jobname", "review");
    const tabs = h("div", "tabs");
    const count = h("p", "dim");
    const list = h("div", "tracks");
    const more = button("show more", () => void load(true));
    const bar = h("div", "applybar");
    const status = statusLine();
    root.append(
        link("< back to the job", jobLink(id), "back"),
        heading,
        tabs,
        count,
        list,
        buttonRow(more),
        bar,
        status.node,
    );

    let job: Job | null = null;
    let filter: Filter = "unmatched";
    let loaded: Track[] = [];
    let total = 0;
    let loading = false;

    const fail = (error: unknown, into = status) => {
        if (signal.aborted || ctx.auth(error)) return;
        into.set(describe(error), true);
    };

    function drawBar(): void {
        const n = job?.pendingPicks ?? 0;
        bar.hidden = n === 0;
        bar.replaceChildren();
        if (n === 0) return;
        const apply = button(`add ${n} picked to the playlist`, async () => {
            apply.disabled = true;
            try {
                await api.apply(id, signal);
                location.hash = jobLink(id);
            } catch (error) {
                apply.disabled = false;
                fail(error);
            }
        });
        bar.append(h("span", "dim", `${n} picked, not in the playlist yet `), apply);
    }

    async function refreshJob(): Promise<void> {
        try {
            job = await api.get(id, signal);
            drawBar();
        } catch (error) {
            fail(error);
        }
    }

    function drawTabs(): void {
        if (!job) return;
        const buttons = reviewTabs(job, filter).map((t) => {
            const b = button(t.label, () => {
                if (t.filter === filter) return;
                filter = t.filter;
                drawTabs();
                void load(false);
            });
            b.classList.toggle("active", t.filter === filter);
            return b;
        });
        tabs.replaceChildren(...buttons);
        tabs.className = "buttons";
    }

    /** One track: its label, its suggestions as buttons, and a box to search Beatport by hand. */
    function trackBlock(initial: Track): HTMLElement {
        let t = initial;
        const box = h("div", "trk");
        let searching = false;
        let searchOpen = false;
        const note = statusLine();
        note.node.className = "dim trknote";

        const pick = async (candidateId: number | null) => {
            try {
                t = await api.pick(id, t.index, candidateId, signal);
                draw();
                await refreshJob();
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
                t = await api.search(id, t.index, query, signal);
                note.set(t.candidates.length ? "" : "nothing found for that search");
                await refreshJob();
            } catch (error) {
                fail(error, note);
            } finally {
                searching = false;
                draw();
            }
        };

        function draw(): void {
            const picked = t.picked !== null;
            const parts: HTMLElement[] = [];
            const head = h("p", "trk-head");
            const lost = t.state === "unreadable" || t.state === "error" || t.verdict === "none";
            head.append(picked ? tone("[+]", "ok") : lost ? tone("[-]", "bad") : tone("[?]", "warn"), t.label);
            if (t.durationSec !== null) head.append(h("span", "dim", ` ${formatTime(t.durationSec)}`));
            parts.push(head);

            if (t.state === "unreadable") {
                const p = h("p", "dim", "could not be read (private or deleted?) ");
                const url = soundcloudUrl(t.url);
                if (url) p.append(external("open on soundcloud", url));
                parts.push(p);
                box.replaceChildren(...parts, note.node);
                return;
            }
            if (t.error) parts.push(h("p", "error", t.error));
            if (t.added) parts.push(h("p", "dim", "already in the Beatport playlist"));
            for (const c of t.candidates) {
                const b = button("", () => void pick(t.picked === c.id ? null : c.id));
                b.classList.add("cand");
                b.classList.toggle("active", t.picked === c.id);
                b.disabled = t.added || searching;
                b.append(candidateText(c), h("span", "dim", ` ${Math.round(c.score * 100)}%`));
                parts.push(b);
            }
            if (t.candidates.length === 0 && !searchOpen) parts.push(h("p", "dim", "no suggestions"));
            if (!t.added) {
                if (searchOpen) {
                    const input = h("input");
                    input.type = "text";
                    input.value = t.query;
                    input.spellcheck = false;
                    input.setAttribute("aria-label", "search Beatport");
                    const go = button(searching ? "searching..." : "search", () => void search(input.value));
                    go.disabled = searching;
                    input.addEventListener("keydown", (e) => {
                        if (e.key === "Enter") void search(input.value);
                    });
                    const row = h("div", "searchbox");
                    row.append(input, go);
                    parts.push(row);
                } else {
                    const open = button("search Beatport by hand", () => {
                        searchOpen = true;
                        draw();
                    });
                    open.classList.add("link");
                    parts.push(open);
                }
            }
            box.replaceChildren(...parts, note.node);
        }

        draw();
        return box;
    }

    async function load(append: boolean): Promise<void> {
        if (loading) return;
        loading = true;
        more.disabled = true;
        if (!append) {
            loaded = [];
            list.replaceChildren(h("p", "dim", "(loading...)"));
            count.textContent = "";
        }
        try {
            const page = await api.tracks(id, filter, loaded.length, PAGE, signal);
            total = page.total;
            if (!append) list.replaceChildren();
            loaded = [...loaded, ...page.tracks];
            list.append(...page.tracks.map(trackBlock));
            count.textContent = total === 0 ? "nothing here" : `${loaded.length} of ${total} shown`;
            if (total === 0) list.replaceChildren(h("p", "dim", "(nothing here)"));
        } catch (error) {
            if (!append) list.replaceChildren();
            fail(error);
        } finally {
            loading = false;
            more.hidden = loaded.length >= total;
            more.disabled = false;
            more.textContent = `show more (${Math.max(0, total - loaded.length)} left)`;
        }
    }

    more.hidden = true;
    bar.hidden = true;
    void (async () => {
        try {
            job = await api.get(id, signal);
        } catch (error) {
            if (error instanceof ApiError && error.status === 404) {
                root.replaceChildren(
                    link("< all jobs", "#sc2bp", "back"),
                    h("p", "error", "this job no longer exists (deleted?)"),
                );
                return;
            }
            fail(error);
            return;
        }
        heading.textContent = `${job.name || fallbackName(job.url)} · review`;
        document.title = `review - ${ctx.baseTitle}`;
        drawTabs();
        drawBar();
        await load(false);
    })();
}
