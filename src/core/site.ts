/**
 * The site map (DESIGN.md section 8): every page, as data. The status line windows, the crumbs and the man header
 * all come from here. Adding a page = one entry here plus its HTML file in `vite.config.js` (a test checks that).
 */
import type { Crumb } from "./shell";

/** The public address of the site, without a trailing slash (feed links must be absolute). */
export const SITE_URL = "https://1000110.xyz";

/** What kind of content the page has (see DESIGN.md section 4). */
export type Pattern = "session" | "listing" | "prose" | "tool";

export interface SitePage {
    id: string;
    /** URL path with a leading and trailing slash. */
    path: string;
    /** Name in the status line (`1:home`). Only top level pages have windows. */
    window: string;
    /** Man header name and section, and the crumb label. */
    name: string;
    section: string;
    pattern: Pattern;
    /** A short remark shown next to the page in listings (e.g. "work in progress"). */
    note?: string;
    /** Id of the page this one lives under (it gets no window; the parent's window stays current). */
    parent?: string;
}

export const pages: SitePage[] = [
    { id: "home", path: "/", window: "home", name: "1000110.xyz", section: "home", pattern: "session" },
    { id: "blog", path: "/blog/", window: "blog", name: "blog", section: "blog", pattern: "listing" },
    { id: "tools", path: "/tools/", window: "tools", name: "tools", section: "tools", pattern: "listing" },
    {
        id: "theme",
        path: "/theme/",
        window: "",
        name: "theme",
        section: "theme",
        pattern: "listing",
        parent: "home",
    },
    {
        id: "experiments",
        path: "/experiments/",
        window: "exp",
        name: "experiments",
        section: "experiments",
        pattern: "listing",
    },
    {
        id: "fluiddynamics",
        path: "/experiments/fluiddynamics/",
        window: "",
        name: "fluiddynamics",
        section: "experiments",
        pattern: "tool",
        note: "work in progress",
        parent: "experiments",
    },
];

export function getPage(id: string): SitePage {
    const page = pages.find((p) => p.id === id);
    if (!page) throw new Error(`unknown page "${id}" (add it to src/core/site.ts)`);
    return page;
}

/** The pages that get a status line window, in order. */
export const windows = (): SitePage[] => pages.filter((p) => !p.parent);

/** The window that is current on `page`: itself, or its top level parent. */
export function currentWindow(page: SitePage): SitePage {
    return page.parent ? currentWindow(getPage(page.parent)) : page;
}

/**
 * Crumbs for `page`: home, any parents, the page, then `extra` (e.g. a post's slug).
 * The page itself is a link only when there is something after it; `selfHref` overrides where that link goes.
 */
export function crumbTrail(page: SitePage, extra?: string, selfHref = page.path): Crumb[] {
    const chain: SitePage[] = [];
    for (let p: SitePage | undefined = page; p; p = p.parent ? getPage(p.parent) : undefined) chain.unshift(p);
    if (chain[0].id !== "home") chain.unshift(getPage("home"));
    const trail = chain.map((p): Crumb => {
        const isPage = p.id === page.id;
        if (isPage && extra === undefined) return { label: p.name };
        return { label: p.name, href: isPage ? selfHref : p.path };
    });
    return extra === undefined ? trail : [...trail, { label: extra }];
}
