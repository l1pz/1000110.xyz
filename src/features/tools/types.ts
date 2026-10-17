/** Categories in listing order; each one is a `ls <category>/` group on the tools page. */
export const CATEGORIES = [
    "crypto",
    "text",
    "dev",
    "network",
    "images",
    "media",
    "files",
    "math",
    "fun",
    "writing",
] as const;

export type Category = (typeof CATEGORIES)[number];

/**
 * `public` tools run in the browser and are listed on `/tools/`. `private` tools need the backend (Pocket ID,
 * owner only) and are never listed or opened on the public page.
 */
export type Access = "public" | "private";

/** What the listing needs to know about a tool; lives in `tools/<id>/meta.ts` and is loaded eagerly. */
export interface ToolMeta {
    /** Same as the folder name: lowercase letters, digits and `-`. */
    id: string;
    /** Short human name, shown on the tool page and as the document title. */
    title: string;
    category: Category;
    /** One line for the listing row. */
    summary: string;
    /** Defaults to `public`. */
    access?: Access;
    /** The tool has one main text box, so other tools may "send" text to it. */
    pipe?: boolean;
    /** Optional hidden binary message (at most 32 characters, like a blog post). */
    secret?: string;
}

/** Called when the user leaves the tool: free workers, object URLs, timers, listeners. */
export type Cleanup = () => void;

/** What `tools/<id>/index.ts` exports. It is only loaded when the tool is opened. */
export interface ToolModule {
    // biome-ignore lint/suspicious/noConfusingVoidType: a tool may return nothing, or a cleanup
    mount(el: HTMLElement): void | Cleanup | Promise<void | Cleanup>;
}
