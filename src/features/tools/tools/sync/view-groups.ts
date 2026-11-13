import { describe, h, link } from "../../backend-dom";
import { button, buttonRow, lineInput, statusLine } from "../../ui";
import type { Group, Status } from "./api";
import { type Ctx, hashFor, navBar } from "./chrome";
import { addGroup, lockedGroups, moveGenre, removeGroup, renameGroup } from "./model";

/**
 * `#sync?v=groups`: which Beatport genres go into which group. Tap a genre, then the group it should go to. Moving a
 * genre only changes where songs go from now on: playlists that already exist are not rearranged.
 */
export function groupsView(ctx: Ctx): void {
    const { api, root, signal } = ctx;
    const body = h("div", "syncgroups");
    const status = statusLine();
    const nav = h("div");
    root.append(link("< home", hashFor("home"), "back"), h("h2", "jobname", "groups"), body, status.node, nav);

    let info: Status | null = null;
    let groups: Group[] = [];
    let saved = "";
    let moving: string | null = null; // the genre waiting for a group to be tapped
    let renaming: string | null = null; // the id of the group being renamed
    let busy = false;

    const dirty = () => JSON.stringify(groups) !== saved;
    const fail = (error: unknown) => {
        if (signal.aborted || ctx.auth(error)) return;
        status.set(describe(error), true);
    };

    async function save(): Promise<void> {
        busy = true;
        status.set("saving...");
        try {
            const config = await api.saveConfig({ groups }, signal);
            groups = config.groups;
            saved = JSON.stringify(groups);
            info = await api.status(signal);
            status.set("saved. songs already on Beatport stay where they are; new ones follow these groups");
        } catch (error) {
            fail(error);
        } finally {
            busy = false;
            draw();
        }
    }

    function chip(genre: string, count?: number): HTMLButtonElement {
        const b = button(count ? `${genre} (${count})` : genre, () => {
            moving = moving === genre ? null : genre;
            draw();
        });
        b.classList.add("chip");
        b.classList.toggle("active", moving === genre);
        return b;
    }

    function targets(): HTMLElement {
        const wrap = h("div", "buttons");
        for (const g of groups) {
            wrap.append(button(g.name, () => move(g.id)));
        }
        wrap.append(button(`${info?.config.otherName ?? "Other"} (unlisted)`, () => move(null)));
        wrap.append(
            button("cancel", () => {
                moving = null;
                draw();
            }),
        );
        return wrap;
    }

    function move(to: string | null): void {
        if (moving === null) return;
        groups = moveGenre(groups, moving, to);
        moving = null;
        status.set("");
        draw();
    }

    function draw(): void {
        if (!info) return;
        const locked = lockedGroups(info);
        const nodes: HTMLElement[] = [];
        if (moving) nodes.push(h("p", "notice warn", `move "${moving}" to:`), targets());
        for (const g of groups) {
            const card = h("div", "syncgroup");
            const isLocked = locked.has(g.id);
            const head = h("p", "grouphead", g.name);
            if (renaming === g.id) {
                const input = lineInput("new name", g.name);
                input.input.value = g.name;
                const done = () => {
                    const next = renameGroup(groups, g.id, input.input.value, info?.config.otherName ?? "Other");
                    if (next.error) return status.set(next.error, true);
                    groups = next.groups;
                    renaming = null;
                    status.set("");
                    draw();
                };
                input.input.addEventListener("keydown", (e) => {
                    if (e.key === "Enter") done();
                });
                card.append(
                    input.wrap,
                    buttonRow(
                        button("ok", done),
                        button("cancel", () => {
                            renaming = null;
                            draw();
                        }),
                    ),
                );
                nodes.push(card);
                continue;
            }
            const tracks = info.groups.find((x) => x.id === g.id)?.tracks ?? 0;
            head.append(h("span", "dim", ` · ${tracks} ${tracks === 1 ? "song" : "songs"}`));
            card.append(head);
            card.append(h("div", "chips"));
            card.lastElementChild?.append(...g.genres.map((x) => chip(x)));
            if (g.genres.length === 0) card.append(h("p", "dim", "(no genres: nothing goes here)"));
            const tools = h("div", "buttons");
            if (!isLocked) {
                tools.append(
                    button("rename", () => {
                        renaming = g.id;
                        draw();
                    }),
                    button("remove", () => {
                        groups = removeGroup(groups, g.id);
                        draw();
                    }),
                );
            } else {
                card.append(h("p", "dim", "has playlists on Beatport, so its name stays"));
            }
            if (tools.childElementCount) card.append(tools);
            nodes.push(card);
        }
        const unlisted = Object.entries(info.otherGenres).filter(
            ([genre]) => !groups.some((g) => g.genres.includes(genre)),
        );
        const other = h("div", "syncgroup");
        other.append(h("p", "grouphead", `${info.config.otherName} (genres no group lists)`));
        other.append(h("div", "chips"));
        other.lastElementChild?.append(...unlisted.map(([genre, n]) => chip(genre, n)));
        if (unlisted.length === 0) other.append(h("p", "dim", "(none: every genre has a group)"));
        nodes.push(other);

        const input = lineInput("new group", "name");
        nodes.push(
            input.wrap,
            buttonRow(
                button("add group", () => {
                    const next = addGroup(groups, input.input.value, info?.config.otherName ?? "Other");
                    if (next.error) status.set(next.error, true);
                    else {
                        groups = next.groups;
                        status.set("");
                    }
                    draw();
                }),
            ),
        );
        const saveBtn = button(busy ? "saving..." : "save groups", () => void save());
        saveBtn.disabled = busy || !dirty();
        nodes.push(buttonRow(saveBtn));
        body.replaceChildren(...nodes);
        nav.replaceChildren(navBar("groups", info.counts));
    }

    void (async () => {
        try {
            info = await api.status(signal);
            groups = info.config.groups.map((g) => ({ ...g, genres: [...g.genres] }));
            saved = JSON.stringify(groups);
            draw();
        } catch (error) {
            fail(error);
        }
    })();
}
