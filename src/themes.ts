import { mountPage } from "./core/boot";
import { currentTheme, getChoice, setChoice } from "./core/theme";
import { themeBody, themeRows } from "./themes-page";

document.addEventListener("DOMContentLoaded", () => {
    const root = document.querySelector("#theme");
    if (!root) return;
    mountPage(root, "theme", {
        command: "ls themes/",
        body: themeBody(getChoice(), currentTheme().id),
        secret: "pick a color, any color",
    });
    const list = root.querySelector("#theme-list");
    if (!list) return;
    // Any change (a tap, the t key, another tab, the system) redraws the rows; keep keyboard focus on the same row.
    document.addEventListener("themechange", () => {
        const focused = list.contains(document.activeElement)
            ? (document.activeElement as HTMLElement).dataset.choice
            : undefined;
        list.innerHTML = themeRows(getChoice(), currentTheme().id);
        if (focused) list.querySelector<HTMLElement>(`[data-choice="${focused}"]`)?.focus();
    });
    list.addEventListener("click", (e) => {
        const row = (e.target as Element).closest<HTMLElement>("[data-choice]");
        if (row?.dataset.choice) setChoice(row.dataset.choice);
    });
});
