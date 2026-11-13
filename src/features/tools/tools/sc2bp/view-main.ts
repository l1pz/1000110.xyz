import { button, buttonRow, lineInput, linkButton, statusLine, toolState } from "../../ui";
import { type Job, MAX_SPLIT, NetworkError } from "./api";
import { type Ctx, describe, h, jobLink, link, startPolling, tone } from "./dom";
import { pollDelay, rowModel, sortJobs, tabTitle } from "./jobs";

/** `#sc2bp`: start a conversion, and see every job with its progress. Jobs run on the server, so closing the page is fine. */
export function mainView(ctx: Ctx): void {
    const { api, root, signal } = ctx;
    const state = toolState("sc2bp");
    const url = lineInput("playlist url (soundcloud or youtube)", "https://soundcloud.com/user/sets/name");
    state.bindText("u", url.input);
    const name = lineInput("beatport playlist name (optional)", "the same as the source playlist");
    const split = lineInput(`tracks per beatport playlist (0 = one playlist, up to ${MAX_SPLIT})`, "100");
    split.input.value = "100";
    split.input.inputMode = "numeric";
    const form = statusLine();
    const startBtn = button("start conversion", () => void begin());
    const heading = h("p", "dim", "jobs/");
    const list = h("div", "jobs");
    const note = statusLine();
    list.append(h("p", "dim", "(loading...)"));

    async function begin(): Promise<void> {
        const playlist = url.input.value.trim();
        if (!playlist) return form.set("paste a soundcloud or youtube playlist link first", true);
        const perList = split.input.value.trim() === "" ? 0 : Number(split.input.value.trim());
        if (!Number.isInteger(perList) || perList < 0 || perList > MAX_SPLIT)
            return form.set(`tracks per playlist must be a whole number from 0 to ${MAX_SPLIT}`, true);
        startBtn.disabled = true;
        form.set("starting...");
        try {
            const { job, created } = await api.start(playlist, name.input.value.trim(), perList, signal);
            form.set(created ? "" : "that playlist is already being converted");
            location.hash = jobLink(job.id);
        } catch (error) {
            if (signal.aborted || ctx.auth(error)) return;
            form.set(describe(error), true);
        } finally {
            startBtn.disabled = false;
        }
    }

    function row(job: Job, now: number): HTMLElement {
        const m = rowModel(job, now);
        const a = link("", jobLink(job.id), "row jobrow");
        const head = h("span", "jobhead");
        head.append(tone(m.mark.text, m.mark.tone), m.name);
        a.append(head, h("span", "dim jobinfo", m.info));
        if (m.bar) a.append(h("span", "bar", m.bar));
        return a;
    }

    startPolling(async () => {
        try {
            const jobs = await api.list(signal);
            const now = Date.now() / 1000;
            note.set("");
            list.replaceChildren(
                ...(jobs.length ? sortJobs(jobs).map((j) => row(j, now)) : [h("p", "dim", "(no jobs yet)")]),
            );
            document.title = tabTitle(jobs, ctx.baseTitle);
            return pollDelay(jobs, document.hidden);
        } catch (error) {
            if (signal.aborted || ctx.auth(error)) return 60_000;
            note.set(describe(error), !(error instanceof NetworkError));
            return 5_000;
        }
    }, signal);

    root.append(
        url.wrap,
        name.wrap,
        split.wrap,
        buttonRow(startBtn, linkButton(state)),
        form.node,
        heading,
        list,
        note.node,
    );
}
