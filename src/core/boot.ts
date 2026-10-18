import { bindKeys } from "./keys";
import { isoDate, renderPage } from "./shell";
import { getPage, type SitePage } from "./site";
import { mountStatusLine } from "./statusline";
import { initTheme } from "./theme";

/**
 * What every page does once it has drawn its content: the saved color theme, the shared status line (windows,
 * clock, progress) into `#status` and the shared keys. Returns `update` for the status line.
 */
export function bootPage(page: SitePage, opts: { up?: () => void } = {}): { update: () => void } {
    let footer = document.querySelector("#status");
    if (!footer) {
        footer = document.createElement("footer");
        footer.id = "status";
        document.body.append(footer);
    }
    initTheme();
    const status = mountStatusLine(footer, page);
    bindKeys(page, opts.up);
    return status;
}

/**
 * For pages whose whole content is one block (experiments, tools): draws the page frame around `body` into `el`
 * and boots the page. `body` is already HTML.
 */
export function mountPage(
    el: Element,
    pageId: string,
    content: { command: string; body: string; secret?: string },
): { update: () => void } {
    const page = getPage(pageId);
    el.innerHTML = renderPage({ page, date: isoDate(new Date()), ...content });
    return bootPage(page);
}
