/**
 * The tools registry. Every tool is a folder `tools/<id>/` with `meta.ts` (loaded eagerly, read by the listing)
 * and `index.ts` (loaded only when the tool is opened, so each tool is its own chunk).
 */
import { CATEGORIES, type Category, type ToolMeta, type ToolModule } from "./types";

const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SECRET_MAX = 32;

function fail(path: string, why: string): never {
    throw new Error(`${path}: ${why}`);
}

/**
 * Checks the `meta` export of every `./tools/<id>/meta.ts` module and returns the tools sorted by category,
 * then id. Throws with the file path on a bad tool, like the blog loader does for a bad post.
 */
export function loadTools(modules: Record<string, { meta?: unknown }>): ToolMeta[] {
    const seen = new Set<string>();
    const tools: ToolMeta[] = [];
    for (const [path, mod] of Object.entries(modules)) {
        const folder = path.match(/\/tools\/([^/]+)\/meta\.ts$/)?.[1];
        if (!folder) fail(path, "expected tools/<id>/meta.ts");
        const meta = mod.meta as Partial<ToolMeta> | undefined;
        if (!meta || typeof meta !== "object") fail(path, "missing `export const meta`");
        if (typeof meta.id !== "string" || !ID.test(meta.id))
            fail(path, "`id` must be lowercase letters, digits and -");
        if (meta.id !== folder) fail(path, `\`id\` "${meta.id}" must match the folder name "${folder}"`);
        if (seen.has(meta.id as string)) fail(path, `duplicate tool id "${meta.id}"`);
        if (!CATEGORIES.includes(meta.category as Category)) {
            fail(path, `\`category\` must be one of ${CATEGORIES.join(", ")}`);
        }
        for (const key of ["title", "summary"] as const) {
            if (typeof meta[key] !== "string" || meta[key] === "") fail(path, `\`${key}\` must be a non-empty string`);
        }
        if (meta.access !== undefined && meta.access !== "public" && meta.access !== "private") {
            fail(path, '`access` must be "public" or "private"');
        }
        if (meta.pipe !== undefined && typeof meta.pipe !== "boolean") fail(path, "`pipe` must be true or false");
        if (meta.secret !== undefined && (typeof meta.secret !== "string" || meta.secret.length > SECRET_MAX)) {
            fail(path, `\`secret\` must be at most ${SECRET_MAX} characters`);
        }
        seen.add(meta.id as string);
        tools.push(meta as ToolMeta);
    }
    const rank = (t: ToolMeta) => CATEGORIES.indexOf(t.category);
    return tools.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

const metaModules = import.meta.glob<{ meta: ToolMeta }>("./tools/*/meta.ts", { eager: true });
const toolModules = import.meta.glob<ToolModule>("./tools/*/index.ts");

/** Every tool, public and private. */
export const allTools: ToolMeta[] = loadTools(metaModules);

/** The tools the public site lists and opens: private ones (backend, owner only) are left out. */
export const publicTools = (tools: ToolMeta[] = allTools): ToolMeta[] =>
    tools.filter((t) => (t.access ?? "public") === "public");

/** A public tool by id, or `undefined` (a private tool looks exactly like a missing one). */
export const getPublicTool = (id: string, tools: ToolMeta[] = allTools): ToolMeta | undefined =>
    publicTools(tools).find((t) => t.id === id);

/** Loads the code of one tool (its own chunk). */
export function loadTool(id: string): Promise<ToolModule> {
    const load = toolModules[`./tools/${id}/index.ts`];
    if (!load) return Promise.reject(new Error(`tools/${id}/index.ts is missing`));
    return load();
}
