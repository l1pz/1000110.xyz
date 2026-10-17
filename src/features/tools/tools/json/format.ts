export type JsonMode = "format" | "minify" | "validate";
export type Indent = "2" | "4" | "tab";

export const MODES: readonly { id: JsonMode; label: string }[] = [
    { id: "format", label: "format" },
    { id: "minify", label: "minify" },
    { id: "validate", label: "validate" },
];

export const INDENTS: readonly { id: Indent; label: string }[] = [
    { id: "2", label: "2 spaces" },
    { id: "4", label: "4 spaces" },
    { id: "tab", label: "tab" },
];

export interface JsonOptions {
    mode: JsonMode;
    indent: Indent;
    sortKeys: boolean;
}

export class JsonError extends Error {}

/** 1-based line and column of a character offset. */
export function lineColumn(text: string, position: number): { line: number; column: number } {
    const before = text.slice(0, position);
    const line = before.split("\n").length;
    return { line, column: position - (before.lastIndexOf("\n") + 1) + 1 };
}

/** Finds where `text` stops being JSON. Returns null when it is valid (the caller then trusts the engine's message). */
export function findError(text: string): { position: number; message: string } | null {
    let i = 0;
    const fail = (message: string): never => {
        throw { position: i, message };
    };
    const space = () => {
        while (i < text.length && " \t\n\r".includes(text[i] ?? "")) i++;
    };
    const unexpected = () => (i >= text.length ? fail("Unexpected end of JSON") : fail(`Unexpected '${text[i]}'`));
    const literal = (word: string) => {
        if (!text.startsWith(word, i)) unexpected();
        i += word.length;
    };
    const string = () => {
        i++; // opening quote
        while (i < text.length && text[i] !== '"') {
            if (text[i] === "\\") {
                i++;
                if (text[i] === "u") {
                    if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) fail("Bad unicode escape");
                    i += 4;
                } else if (!`"\\/bfnrt`.includes(text[i] ?? "")) fail("Bad escape");
            } else if (text[i] < " ") fail("Control character in string");
            i++;
        }
        if (i >= text.length) fail("Unterminated string");
        i++; // closing quote
    };
    const value = (): void => {
        space();
        const c = text[i];
        if (c === "{") {
            i++;
            space();
            if (text[i] === "}") return void i++;
            for (;;) {
                space();
                if (text[i] !== '"') unexpected();
                string();
                space();
                if (text[i] !== ":") unexpected();
                i++;
                value();
                space();
                if (text[i] === ",") i++;
                else if (text[i] === "}") return void i++;
                else unexpected();
            }
        } else if (c === "[") {
            i++;
            space();
            if (text[i] === "]") return void i++;
            for (;;) {
                value();
                space();
                if (text[i] === ",") i++;
                else if (text[i] === "]") return void i++;
                else unexpected();
            }
        } else if (c === '"') string();
        else if (c === "t") literal("true");
        else if (c === "f") literal("false");
        else if (c === "n") literal("null");
        else {
            const num = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
            if (!num) unexpected();
            else i += num[0].length;
        }
    };
    try {
        value();
        space();
        if (i < text.length) fail(`Unexpected '${text[i]}' after the end of the value`);
        return null;
    } catch (err) {
        if (err && typeof err === "object" && "position" in err) return err as { position: number; message: string };
        throw err;
    }
}

/** Engines word the parse error differently (some give no position), so the location comes from `findError`. */
function describe(text: string, err: unknown): string {
    const found = findError(text);
    if (!found) return err instanceof Error ? err.message : String(err);
    const { line, column } = lineColumn(text, found.position);
    return `${found.message} (line ${line}, column ${column})`;
}

function sortDeep(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortDeep);
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([k, v]) => [k, sortDeep(v)]),
        );
    }
    return value;
}

/** Runs the formatter. Throws `JsonError` with a position when the text is not JSON. Empty input gives empty output. */
export function formatJson(text: string, { mode, indent, sortKeys }: JsonOptions): string {
    if (!text.trim()) return "";
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch (err) {
        throw new JsonError(describe(text, err));
    }
    if (mode === "validate") return "valid JSON";
    if (sortKeys) value = sortDeep(value);
    if (mode === "minify") return JSON.stringify(value);
    return JSON.stringify(value, null, indent === "tab" ? "\t" : Number(indent));
}
