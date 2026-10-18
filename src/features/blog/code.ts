import { highlight, type Lang, splitHtmlLines } from "../../core/highlight";
import { codeBoxHtml } from "./markdown";

/** Reads a drawn code box back into its lines: the rows between the borders, minus the `│ ` and ` │` edges. */
export function readBox(box: string): string[] {
    return box
        .split("\n")
        .slice(1, -1)
        .map((row) => row.slice(2, -2));
}

/** The box of a code block with its code colored. Same text, same width: only spans are added. */
export async function colorBox(box: string, lang: Lang | string): Promise<string> {
    const label = box.split("\n")[0].match(/^┌─ ([^ ]+) /)?.[1] ?? "";
    const raws = readBox(box);
    const lines = splitHtmlLines(await highlight(lang, raws.join("\n")));
    return codeBoxHtml(
        raws.map((raw, i) => ({ raw, html: lines[i] ?? "" })),
        label,
        true,
    );
}

/**
 * Colors the code blocks of a rendered post. The renderer stays synchronous and pure (the RSS feed uses it too), so
 * blocks come out plain with a `data-lang`; this swaps in the colored ones. The highlighter loads only if a post has one.
 */
export async function highlightBlocks(root: ParentNode): Promise<void> {
    const blocks = [...root.querySelectorAll<HTMLElement>("pre.code[data-lang]:not([data-colored])")];
    for (const block of blocks) {
        try {
            const html = await colorBox(block.textContent ?? "", block.dataset.lang ?? "");
            const holder = document.createElement("div");
            holder.innerHTML = html;
            if (block.isConnected && holder.firstElementChild) block.replaceWith(holder.firstElementChild);
        } catch {
            block.dataset.colored = ""; // the highlighter failed to load: the plain block stays
        }
    }
}
