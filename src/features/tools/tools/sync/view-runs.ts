import { describe, h, link, tone } from "../../backend-dom";
import { statusLine } from "../../ui";
import { type Ctx, hashFor, navBar } from "./chrome";
import { runMark, runSummary } from "./model";

/** `#sync?v=runs`: the last runs, newest first. */
export function runsView(ctx: Ctx): void {
    const { api, root, signal } = ctx;
    const list = h("div", "jobs");
    const status = statusLine();
    const nav = h("div");
    root.append(link("< home", hashFor("home"), "back"), h("h2", "jobname", "history"), list, status.node, nav);
    list.append(h("p", "dim", "(loading...)"));

    void (async () => {
        try {
            const [runs, info] = await Promise.all([api.runs(signal), api.status(signal)]);
            const now = Date.now() / 1000;
            list.replaceChildren(
                ...(runs.length
                    ? runs.map((r) => {
                          const row = h("p", "histrow");
                          const mark = runMark(r);
                          row.append(tone(mark.text, mark.tone), ` ${runSummary(r, now)}`);
                          return row;
                      })
                    : [h("p", "dim", "(no syncs yet)")]),
            );
            nav.replaceChildren(navBar("runs", info.counts));
        } catch (error) {
            list.replaceChildren();
            if (signal.aborted || ctx.auth(error)) return;
            status.set(describe(error), true);
        }
    })();
}
