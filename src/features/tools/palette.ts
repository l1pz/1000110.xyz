/** The tools search ("command palette"). `rankTools` is pure; `mountPalette` is the overlay and the keys that open it. */
import { escapeHtml } from "../../core/html";
import type { ToolMeta } from "./types";

/** True when `needle` appears in `hay` in order, not necessarily next to each other ("jsn" in "json"). */
function inOrder(needle: string, hay: string): boolean {
    let at = 0;
    for (const ch of needle) {
        at = hay.indexOf(ch, at) + 1;
        if (at === 0) return false;
    }
    return true;
}

/** Lower is better; `null` means this word does not match the tool. */
function score(word: string, tool: ToolMeta): number | null {
    const id = tool.id;
    if (id === word) return 0;
    if (id.startsWith(word)) return 1;
    if (id.includes(word)) return 2;
    if (tool.title.toLowerCase().includes(word)) return 3;
    if (tool.summary.toLowerCase().includes(word)) return 4;
    if (tool.category.includes(word)) return 5;
    if (inOrder(word, id)) return 6;
    return null;
}

/**
 * The tools that match `query`, best first (ties keep the given order). Every word must match; an empty
 * query returns all tools.
 */
export function rankTools(query: string, tools: ToolMeta[]): ToolMeta[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [...tools];
    const ranked: { tool: ToolMeta; total: number; index: number }[] = [];
    tools.forEach((tool, index) => {
        let total = 0;
        for (const word of words) {
            const s = score(word, tool);
            if (s === null) return;
            total += s;
        }
        ranked.push({ tool, total, index });
    });
    return ranked.sort((a, b) => a.total - b.total || a.index - b.index).map((r) => r.tool);
}

const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && /^(input|textarea|select)$/i.test(t.tagName);

/**
 * `/` and Ctrl-K open the search (`/` only when you are not typing), and any element with `data-palette` opens it
 * on click (the phone has no `/` key). Returns a cleanup that removes the listeners.
 */
export function mountPalette(tools: ToolMeta[]): () => void {
    let overlay: HTMLElement | null = null;

    const close = () => {
        overlay?.remove();
        overlay = null;
    };

    const open = () => {
        if (overlay) return;
        const box = document.createElement("div");
        box.className = "palette";
        box.innerHTML =
            '<div class="palette-box tool" role="dialog" aria-label="search tools"><input type="text" placeholder="search tools" autocomplete="off" spellcheck="false" autocapitalize="off"><div class="palette-list"></div></div>';
        const input = box.querySelector("input") as HTMLInputElement;
        const list = box.querySelector(".palette-list") as HTMLElement;
        let picked = 0;
        let shown: ToolMeta[] = [];

        const draw = () => {
            shown = rankTools(input.value, tools);
            picked = Math.min(picked, Math.max(0, shown.length - 1));
            list.innerHTML = shown.length
                ? shown
                      .map(
                          (t, i) =>
                              `<a class="row tool-row${i === picked ? " picked" : ""}" href="#${encodeURIComponent(t.id)}"><span>${escapeHtml(t.id)}/</span><span class="dim">${escapeHtml(t.summary)}</span></a>`,
                      )
                      .join("")
                : '<p class="dim">(no match)</p>';
            list.querySelector(".picked")?.scrollIntoView({ block: "nearest" });
        };

        input.addEventListener("input", () => {
            picked = 0;
            draw();
        });
        input.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                e.preventDefault();
                close();
            } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                if (shown.length) picked = (picked + (e.key === "ArrowDown" ? 1 : shown.length - 1)) % shown.length;
                draw();
            } else if (e.key === "Enter") {
                e.preventDefault();
                const tool = shown[picked];
                if (tool) location.hash = `#${encodeURIComponent(tool.id)}`;
                close();
            }
        });
        // A tap or click on a row follows its link (hash change); the backdrop and the links close the search.
        box.addEventListener("click", (e) => {
            if (e.target === box || (e.target as HTMLElement).closest("a")) close();
        });
        document.body.append(box);
        overlay = box;
        draw();
        input.focus();
    };

    const onKey = (e: KeyboardEvent) => {
        if (e.key === "k" && e.ctrlKey && !e.altKey && !e.metaKey) {
            e.preventDefault();
            open();
        } else if (e.key === "/" && !e.ctrlKey && !e.altKey && !e.metaKey && !isTyping(e.target)) {
            e.preventDefault();
            open();
        }
    };
    const onClick = (e: MouseEvent) => {
        if ((e.target as HTMLElement | null)?.closest("[data-palette]")) open();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    return () => {
        document.removeEventListener("keydown", onKey);
        document.removeEventListener("click", onClick);
        close();
    };
}
