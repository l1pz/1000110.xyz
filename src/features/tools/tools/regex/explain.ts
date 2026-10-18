/** What kind of pattern part a token is; the highlighter colors by it. */
export type StepKind = "escape" | "class" | "group" | "quantifier" | "alternation" | "anchor" | "any" | "literal";

export interface Step {
    /** Nesting depth: groups indent what is inside them. */
    depth: number;
    kind: StepKind;
    token: string;
    meaning: string;
}

const ESCAPES: Record<string, string> = {
    d: "a digit",
    D: "anything but a digit",
    w: "a letter, digit or _",
    W: "anything but a letter, digit or _",
    s: "whitespace",
    S: "anything but whitespace",
    b: "a word boundary",
    B: "not a word boundary",
    n: "a newline",
    r: "a carriage return",
    t: "a tab",
    f: "a form feed",
    v: "a vertical tab",
    0: "a null character",
};

const GROUPS: [string, string][] = [
    ["(?:", "non-capturing group"],
    ["(?=", "lookahead: followed by"],
    ["(?!", "negative lookahead: not followed by"],
    ["(?<=", "lookbehind: preceded by"],
    ["(?<!", "negative lookbehind: not preceded by"],
];

function escapeMeaning(token: string): string {
    const c = token[1];
    if (c in ESCAPES) return ESCAPES[c];
    if (/^\\u\{?[0-9a-fA-F]+\}?$/.test(token) || /^\\x[0-9a-fA-F]{2}$/.test(token)) return `the character ${token}`;
    if (/^\\[pP]\{/.test(token)) return `${c === "p" ? "a" : "not a"} Unicode property ${token.slice(3, -1)}`;
    if (/^\\k</.test(token)) return `the same text as group ${token.slice(3, -1)}`;
    if (/^\\[1-9]/.test(token)) return `the same text as group ${token.slice(1)}`;
    return `the character ${c}`;
}

function classMeaning(token: string): string {
    const negated = token[1] === "^";
    const body = token.slice(negated ? 2 : 1, -1);
    return `${negated ? "any character except" : "one of"}: ${body}`;
}

function quantifierMeaning(token: string): string {
    const lazy = token.endsWith("?") && token.length > 1;
    const core = lazy ? token.slice(0, -1) : token;
    let text: string;
    if (core === "*") text = "zero or more times";
    else if (core === "+") text = "one or more times";
    else if (core === "?") text = "optional (zero or one)";
    else {
        const [min, max] = core.slice(1, -1).split(",");
        if (max === undefined) text = `exactly ${min} times`;
        else if (max === "") text = `${min} or more times`;
        else text = `${min} to ${max} times`;
    }
    return lazy ? `${text}, as few as possible` : text;
}

/**
 * Walks a pattern and says what each part does, one step per token. Not a full parser: it reads the usual JS
 * syntax and falls back to "the character x" for anything it does not know. Never throws.
 */
export function explain(pattern: string): Step[] {
    const steps: Step[] = [];
    let depth = 0;
    let i = 0;
    const add = (kind: StepKind, token: string, meaning: string, at = depth) =>
        steps.push({ depth: at, kind, token, meaning });

    while (i < pattern.length) {
        const rest = pattern.slice(i);
        const c = pattern[i];
        const quantifier = /^(?:[*+?]|\{\d+(?:,\d*)?\})\??/.exec(rest);

        if (c === "\\") {
            const token =
                /^\\(?:u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[pP]\{[^}]*\}|k<[^>]*>|[1-9][0-9]*|.)/s.exec(
                    rest,
                )?.[0] ?? c;
            add("escape", token, escapeMeaning(token));
            i += token.length;
        } else if (c === "[") {
            const token = /^\[\^?(?:\\.|[^\]\\])*\]?/s.exec(rest)?.[0] ?? c;
            add("class", token, classMeaning(token));
            i += token.length;
        } else if (c === "(") {
            const named = /^\(\?<([A-Za-z_$][\w$]*)>/.exec(rest);
            const kind = GROUPS.find(([open]) => rest.startsWith(open));
            if (named) add("group", named[0], `start of capture group "${named[1]}"`);
            else if (kind) add("group", kind[0], `start of ${kind[1]}`);
            else add("group", "(", "start of capture group");
            const length = named?.[0].length ?? kind?.[0].length ?? 1;
            depth++;
            i += length;
        } else if (c === ")") {
            depth = Math.max(0, depth - 1);
            add("group", ")", "end of group");
            i++;
        } else if (quantifier) {
            add("quantifier", quantifier[0], quantifierMeaning(quantifier[0]));
            i += quantifier[0].length;
        } else if (c === "|") {
            add("alternation", "|", "or: either side matches", Math.max(0, depth - 1));
            i++;
        } else if (c === "^") {
            add("anchor", "^", "start of the text (or of a line with the m flag)");
            i++;
        } else if (c === "$") {
            add("anchor", "$", "end of the text (or of a line with the m flag)");
            i++;
        } else if (c === ".") {
            add("any", ".", "any character except a newline (with the s flag, any character)");
            i++;
        } else {
            const [cp] = rest;
            const token = String.fromCodePoint(cp.codePointAt(0) ?? 0);
            add("literal", token, `the character ${token}`);
            i += token.length;
        }
    }
    return steps;
}
