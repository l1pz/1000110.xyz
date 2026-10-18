/**
 * The theme must be on <html> before the first paint, or a saved theme flashes the default one. Module scripts
 * run too late, so this tiny blocking script is injected into the head of every page (never copied by hand).
 * It mirrors `readChoice` / `resolveTheme` in src/core/theme.ts (tests/theme.test.ts runs it against them);
 * an unknown id only means no CSS block matches, and theme.ts corrects it once the module runs.
 */
export const bootScript = [
    "var t;",
    'try{t=localStorage.getItem("theme")}catch(e){}',
    'if(typeof t!=="string"||t==="auto"||!/^[a-z-]+$/.test(t))',
    't=typeof matchMedia==="function"&&matchMedia("(prefers-color-scheme: light)").matches?"gruvbox-light":"gruvbox-dark";',
    "document.documentElement.dataset.theme=t;",
].join("");

export default function themeBoot() {
    return {
        name: "theme-boot",
        transformIndexHtml: {
            order: "pre",
            handler: () => [{ tag: "script", children: bootScript, injectTo: "head-prepend" }],
        },
    };
}
