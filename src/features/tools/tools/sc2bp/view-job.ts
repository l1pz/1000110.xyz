import { button, buttonRow, statusLine } from "../../ui";
import { ApiError, beatportUrl, type Job, NetworkError } from "./api";
import { type Ctx, describe, external, h, jobLink, link, startPolling, tone } from "./dom";
import {
    type ActionId,
    actionsFor,
    ago,
    barText,
    fallbackName,
    noticeFor,
    phaseText,
    pollDelay,
    resultModel,
    stateMark,
    waitingText,
} from "./jobs";

const STATE_WORDS: Record<Job["state"], string> = {
    queued: "waiting in the queue",
    running: "running",
    paused: "paused",
    failed: "stopped",
    cancelled: "cancelled",
    done: "done",
};

/** `#sc2bp?j=<id>`: one job. While it runs only the phase and counts are shown, not the tracks. */
export function jobView(ctx: Ctx, id: string): void {
    const { api, root, signal } = ctx;
    const back = link("< all jobs", "#sc2bp", "back");
    const body = h("div", "jobbody");
    const status = statusLine();
    root.append(back, body, status.node);

    let job: Job | null = null;
    let confirming = false; // the delete button asks twice; this survives the redraw every poll
    let confirmTimer: ReturnType<typeof setTimeout> | undefined;
    let gone = false;

    async function run(action: ActionId): Promise<void> {
        if (!job) return;
        if (action === "review") {
            location.hash = jobLink(id, true);
            return;
        }
        if (action === "delete") {
            if (!confirming) {
                confirming = true;
                confirmTimer = setTimeout(() => {
                    confirming = false;
                    if (job) draw(job);
                }, 4000);
                draw(job);
                return;
            }
            clearTimeout(confirmTimer);
        }
        status.set("");
        try {
            if (action === "cancel") job = await api.cancel(id, signal);
            else if (action === "retry") job = await api.retry(id, signal);
            else if (action === "apply") job = await api.apply(id, signal);
            else {
                await api.remove(id, signal);
                location.hash = "sc2bp";
                return;
            }
            draw(job);
            poll.now();
        } catch (error) {
            if (signal.aborted || ctx.auth(error)) return;
            confirming = false;
            status.set(describe(error), true);
            if (job) draw(job);
        }
    }

    function draw(j: Job): void {
        job = j;
        const now = Date.now() / 1000;
        const mark = stateMark(j.state);
        const parts: HTMLElement[] = [];

        parts.push(h("h2", "jobname", j.name || fallbackName(j.url)));
        const line = h("p", "jobstate");
        line.append(tone(mark.text, mark.tone), ` ${STATE_WORDS[j.state]}`);
        if (j.state === "running") line.append(h("span", "dim", ` · ${phaseText(j)}`));
        parts.push(line);
        if (j.state === "running" || j.state === "paused") parts.push(h("p", "bar", barText(j)));
        parts.push(h("p", "dim", `started ${ago(j.created, now)}`));

        const waiting = waitingText(j.waiting, now);
        if (waiting) parts.push(h("p", "notice warn", waiting));
        const notice = noticeFor(j);
        if (notice) parts.push(h("p", `notice ${notice.tone}`, notice.text));

        if (j.state === "done") {
            const result = resultModel(j);
            parts.push(h("p", "result", result.headline));
            if (result.lines.length) parts.push(h("p", "dim resultlines", result.lines.join("\n")));
            const url = beatportUrl(j.playlist?.url ?? null);
            if (url) {
                const p = h("p");
                p.append(external("open the playlist on Beatport", url));
                parts.push(p);
            }
        } else if (j.state === "cancelled" && j.counts.added > 0) {
            parts.push(h("p", "dim", `${j.counts.added} tracks were already added to the Beatport playlist.`));
        }

        const buttons = actionsFor(j).map((a) => {
            const asking = a.id === "delete" && confirming;
            const b = button(asking ? "really delete? tap again" : a.label, () => void run(a.id));
            if (asking) b.classList.add("active");
            return b;
        });
        parts.push(buttonRow(...buttons));
        if (j.state === "done" || j.state === "cancelled" || j.state === "failed") {
            parts.push(h("p", "dim", "Deleting a job removes it from this list only; the Beatport playlist stays."));
        }
        body.replaceChildren(...parts);
    }

    const poll = startPolling(async () => {
        if (gone) return 60_000;
        try {
            const j = await api.get(id, signal);
            status.set("");
            draw(j);
            document.title = `${j.name || "job"} - ${ctx.baseTitle}`;
            return pollDelay([j], document.hidden);
        } catch (error) {
            if (signal.aborted || ctx.auth(error)) return 60_000;
            if (error instanceof ApiError && error.status === 404) {
                gone = true;
                body.replaceChildren(h("p", "error", "this job no longer exists (deleted?)"));
                return 60_000;
            }
            status.set(describe(error), !(error instanceof NetworkError));
            return 5_000;
        }
    }, signal);
}
