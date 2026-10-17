import { bootPage } from "../../core/boot";
import { escapeHtml } from "../../core/html";
import { isoDate, renderPage } from "../../core/shell";
import { crumbTrail, getPage } from "../../core/site";
import { getPublicTool, loadTool, publicTools } from "./registry";
import { splitHash } from "./state";
import { CATEGORIES, type Cleanup, type ToolMeta } from "./types";

export type Route = { view: "index" } | { view: "tool"; id: string };

/** `/tools/` is the list, `/tools/#<id>` is one tool; `#<id>?k=v` carries the tool's state (see `state.ts`). */
export function parseRoute(hash: string): Route {
    const { id } = splitHash(hash);
    return id === "" ? { view: "index" } : { view: "tool", id };
}

const tools = () => getPage("tools");
/** Crumbs for a page inside the tools: the "tools" crumb goes back to the list (an in-page hash change). */
const trail = (id: string) => crumbTrail(tools(), id, "#");

/** Listing rows grouped by category (`crypto/`, `text/`, ...); each row is one link, so the whole line is a tap target. */
export function toolRows(list: ToolMeta[]): string {
    if (list.length === 0) return '<p class="dim">(nothing here yet)</p>';
    return CATEGORIES.filter((c) => list.some((t) => t.category === c))
        .map((category) => {
            const rows = list
                .filter((t) => t.category === category)
                .map(
                    (t) =>
                        `<a class="row tool-row" href="#${encodeURIComponent(t.id)}"><span>${escapeHtml(t.id)}/</span><span class="dim">${escapeHtml(t.summary)}</span></a>`,
                );
            return `<section class="group"><div class="dim">${category}/</div>\n${rows.join("\n")}</section>`;
        })
        .join("\n");
}

/** The `/tools/` list. `today` is the man header date. */
export function renderIndex(list: ToolMeta[], today: string): string {
    return renderPage({
        page: tools(),
        command: "ls tools/",
        date: today,
        body: `<p class="dim">total ${list.length}</p>\n${toolRows(list)}`,
        secret: "swiss army knife",
    });
}

/** The frame around one tool; the tool mounts into `#tool`. */
export function renderTool(tool: ToolMeta, today: string): string {
    return renderPage({
        page: tools(),
        trail: trail(tool.id),
        name: tool.id,
        command: tool.id,
        date: today,
        body: `<h1 class="title">${escapeHtml(tool.title)}</h1>\n<div id="tool" class="tool"></div>`,
        secret: tool.secret,
    });
}

/** Unknown ids and private tools look the same. */
export function renderNotFound(id: string, today: string): string {
    return renderPage({
        page: tools(),
        trail: trail(id),
        name: "error",
        command: id,
        date: today,
        body: [
            `<p class="error">bash: ${escapeHtml(id)}: command not found</p>`,
            '<p><a href="#">cd ~/tools</a></p>',
        ].join("\n"),
    });
}

/** Draws the page into `el` and wires up the hash routing, the shared status line and the shared keys. */
export async function mount(el: Element): Promise<void> {
    el.innerHTML = '<main id="content" class="page"></main>';
    const content = el.querySelector<HTMLElement>("#content");
    if (!content) return;

    // "up" from a tool is the list; from the list it is home (the default).
    const status = bootPage(tools(), {
        up: () => {
            if (location.hash) location.hash = "";
            else location.href = "/";
        },
    });

    let cleanup: Cleanup | undefined;
    let shown = 0;

    const open = async (tool: ToolMeta, id: number) => {
        const host = content.querySelector<HTMLElement>("#tool");
        if (!host) return;
        host.innerHTML = '<p class="dim">loading...</p>';
        try {
            const mod = await loadTool(tool.id);
            if (id !== shown) return; // the user already left
            host.replaceChildren();
            const done = await mod.mount(host);
            if (id !== shown)
                done?.(); // left while mounting
            else cleanup = done ?? undefined;
        } catch (err) {
            if (id === shown) host.innerHTML = `<p class="error">${escapeHtml(String(err))}</p>`;
        }
        status.update();
    };

    const show = () => {
        cleanup?.();
        cleanup = undefined;
        const id = ++shown;
        const today = isoDate(new Date());
        const route = parseRoute(location.hash);
        if (route.view === "index") {
            content.innerHTML = renderIndex(publicTools(), today);
            document.title = "tools - 1000110.xyz";
        } else {
            const tool = getPublicTool(route.id);
            content.innerHTML = tool ? renderTool(tool, today) : renderNotFound(route.id, today);
            document.title = `${tool ? tool.title : "not found"} - 1000110.xyz`;
            if (tool) void open(tool, id);
        }
        window.scrollTo(0, 0);
        status.update();
    };

    window.addEventListener("hashchange", show);
    show();
}
