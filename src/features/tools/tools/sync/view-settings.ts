import { describe, h, link } from "../../backend-dom";
import { button, buttonRow, lineInput, statusLine, toggleButton } from "../../ui";
import { MAX_CAP, type Status } from "./api";
import { type Ctx, hashFor, navBar } from "./chrome";
import { COOKIE_FIX, hasPlaylists, healthModel, nightlyTime, settingsPatch } from "./model";

/** `#sync?v=settings`: the playlist to follow, how the playlists are named and sized, the nightly sync, the cookies. */
export function settingsView(ctx: Ctx): void {
    const { api, root, signal } = ctx;
    const body = h("div", "syncsettings");
    const status = statusLine();
    const nav = h("div");
    root.append(link("< home", hashFor("home"), "back"), h("h2", "jobname", "settings"), body, status.node, nav);

    const fail = (error: unknown) => {
        if (signal.aborted || ctx.auth(error)) return;
        status.set(describe(error), true);
    };

    function draw(s: Status): void {
        const c = s.config;
        const source = lineInput(
            "youtube playlist (liked music is list=LM)",
            "https://music.youtube.com/playlist?list=LM",
        );
        source.input.value = c.source;
        const prefix = lineInput("playlist name prefix", "Liked");
        prefix.input.value = c.prefix;
        const locked = hasPlaylists(s);
        prefix.input.disabled = locked;
        const cap = lineInput(`songs per playlist (1 to ${MAX_CAP})`, "100");
        cap.input.value = String(c.cap);
        cap.input.inputMode = "numeric";
        let nightly = c.nightly.enabled;
        const toggle = toggleButton("sync every night", nightly, (on) => {
            nightly = on;
            toggle.textContent = on ? "sync every night: on" : "sync every night: off";
        });
        toggle.textContent = nightly ? "sync every night: on" : "sync every night: off";
        const time = lineInput(`time of the nightly sync (${c.nightly.tz})`, "04:30");
        time.input.value = nightlyTime(c.nightly);

        const saveBtn = button("save settings", async () => {
            const { patch, error } = settingsPatch(
                {
                    source: source.input.value,
                    prefix: prefix.input.value,
                    cap: cap.input.value,
                    nightly,
                    time: time.input.value,
                },
                c,
            );
            if (error) return status.set(error, true);
            if (Object.keys(patch).length === 0) return status.set("nothing changed");
            saveBtn.disabled = true;
            status.set("saving...");
            try {
                await api.saveConfig(patch, signal);
                status.set("saved");
                draw(await api.status(signal));
            } catch (e) {
                saveBtn.disabled = false;
                fail(e);
            }
        });

        const model = healthModel(s.health);
        const cookies = h("div", "syncgroup");
        cookies.append(h("p", "grouphead", "youtube login"));
        cookies.append(h("p", "dim", s.health.status === "needs-cookies" ? "expired" : "no problem reported"));
        cookies.append(h("p", "dim", `if it expires: ${COOKIE_FIX}`));
        if (s.health.status === "needs-cookies") cookies.append(h("p", "notice warn", model.text));

        const job = lineInput("reuse an earlier conversion of the same playlist (its id)", "8 letters and digits");
        const importBtn = button("import it", async () => {
            const id = job.input.value.trim();
            if (!/^[0-9a-f]{8}$/.test(id)) return status.set("a conversion id is 8 characters from 0-9 and a-f", true);
            status.set("importing...");
            try {
                const done = await api.importJob(id, signal);
                status.set(`imported ${done.imported} of ${done.total} songs; the next sync uses their matches`);
            } catch (e) {
                fail(e);
            }
        });

        body.replaceChildren(
            source.wrap,
            prefix.wrap,
            ...(locked
                ? [h("p", "dim", "the prefix is in the names of playlists that exist, so it cannot change")]
                : []),
            cap.wrap,
            buttonRow(toggle),
            time.wrap,
            buttonRow(saveBtn),
            cookies,
            job.wrap,
            buttonRow(importBtn),
        );
        nav.replaceChildren(navBar("settings", s.counts));
    }

    void (async () => {
        try {
            draw(await api.status(signal));
        } catch (error) {
            fail(error);
        }
    })();
}
