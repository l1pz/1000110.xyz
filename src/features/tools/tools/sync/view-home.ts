import { beatportUrl } from "../../backend";
import { describe, external, h, startPolling, tone } from "../../backend-dom";
import { button, buttonRow, statusLine } from "../../ui";
import { NetworkError, type Run, type Status } from "./api";
import { type Ctx, navBar } from "./chrome";
import {
    healthModel,
    isActive,
    isOpen,
    nextText,
    phaseText,
    pollDelay,
    previewHeadline,
    previewLines,
    runBar,
    runMark,
    runSummary,
    summaryLines,
    tabTitle,
    whenText,
} from "./model";

/** `#sync`: how the sync is doing, the button, the run in progress, and the groups with their playlists. */
export function homeView(ctx: Ctx): void {
    const { api, root, signal } = ctx;
    const health = h("div", "synchealth");
    const syncBtn = button("sync now", () => void start());
    const run = h("div", "syncrun");
    const summary = h("div", "syncsummary");
    const groups = h("div", "syncgroups");
    const nav = h("div");
    const note = statusLine();
    root.append(health, buttonRow(syncBtn), run, summary, nav, groups, note.node);

    let status: Status | null = null;

    const fail = (error: unknown) => {
        if (signal.aborted || ctx.auth(error)) return;
        note.set(describe(error), !(error instanceof NetworkError));
    };

    async function act(call: () => Promise<unknown>): Promise<void> {
        note.set("");
        try {
            await call();
            poll.now();
        } catch (error) {
            fail(error);
            poll.now();
        }
    }

    const start = () => act(() => api.start(signal));

    function drawRun(r: Run | null, now: number): void {
        run.replaceChildren();
        if (!r) return;
        const mark = runMark(r);
        if (!isOpen(r)) {
            const line = h("p", "dim");
            line.append(tone(mark.text, mark.tone), ` last sync: ${runSummary(r, now)}`);
            run.append(line);
            return;
        }
        const line = h("p", "jobstate");
        line.append(tone(mark.text, mark.tone), r.state === "awaiting" ? " waiting for your yes" : ` ${phaseText(r)}`);
        run.append(line);
        if (isActive(r)) run.append(h("p", "bar", runBar(r)));
        if (r.waiting)
            run.append(
                h(
                    "p",
                    "notice warn",
                    `retrying in ${Math.max(0, Math.ceil(r.waiting.until - now))}s (${r.waiting.reason})`,
                ),
            );
        if (r.state === "awaiting" && r.preview) {
            run.append(
                h("p", "result", previewHeadline(r.preview)),
                h("p", "dim resultlines", previewLines(r.preview).join("\n")),
            );
            run.append(
                h(
                    "p",
                    "dim",
                    "nothing has been created yet. your old playlists are not touched, and nothing is ever removed.",
                ),
                buttonRow(
                    button("yes, add them", () => void act(() => api.confirm(r.id, signal))),
                    button("cancel", () => void act(() => api.cancel(r.id, signal))),
                ),
            );
        } else if (isActive(r)) {
            run.append(buttonRow(button("cancel", () => void act(() => api.cancel(r.id, signal)))));
        }
    }

    function drawGroups(s: Status): void {
        const rows = s.groups.filter((g) => g.tracks > 0 || g.playlists.length > 0);
        if (rows.length === 0) {
            groups.replaceChildren(
                h(
                    "p",
                    "dim",
                    s.confirmedOnce
                        ? "(nothing is on Beatport yet)"
                        : "press sync now. the first sync shows what it would do and waits for your yes before it creates anything.",
                ),
            );
            return;
        }
        const nodes: HTMLElement[] = [h("p", "dim", "groups/")];
        for (const g of rows) {
            const row = h("div", "syncgroup");
            row.append(h("p", "grouphead", `${g.name} · ${g.tracks} ${g.tracks === 1 ? "song" : "songs"}`));
            const lists = h("p", "dim playlists");
            g.playlists.forEach((p, i) => {
                if (i) lists.append(" · ");
                const url = beatportUrl(p.url);
                const label = `${p.name.replace(/^.* #/, "#")} (${p.count})${p.gone ? " gone" : ""}`;
                lists.append(url && !p.gone ? external(label, url) : label);
            });
            row.append(lists);
            nodes.push(row);
        }
        groups.replaceChildren(...nodes);
    }

    function draw(s: Status): void {
        status = s;
        const now = Date.now() / 1000;
        const model = healthModel(s.health);
        const line = h("p", "healthline");
        line.append(tone(model.mark.text, model.mark.tone), ` ${model.text}`);
        const parts: HTMLElement[] = [line];
        if (model.fix) parts.push(h("p", "notice warn", model.fix));
        parts.push(h("p", "dim", `last good sync: ${whenText(s.lastSuccess, now)} · ${nextText(s, now)}`));
        health.replaceChildren(...parts);

        const open = isOpen(s.run);
        syncBtn.disabled = open;
        syncBtn.hidden = s.run?.state === "awaiting"; // the preview below has its own buttons
        syncBtn.textContent = isActive(s.run) ? "syncing..." : "sync now";
        drawRun(s.run, now);
        summary.replaceChildren(...summaryLines(s.counts).map((t) => h("p", "", t)));
        drawGroups(s);
        nav.replaceChildren(navBar("home", s.counts));
        document.title = tabTitle(s.run, ctx.baseTitle);
    }

    const poll = startPolling(async () => {
        try {
            draw(await api.status(signal));
            note.set("");
            return pollDelay(status?.run ?? null, document.hidden);
        } catch (error) {
            fail(error);
            return error instanceof NetworkError ? 5_000 : 30_000;
        }
    }, signal);
}
