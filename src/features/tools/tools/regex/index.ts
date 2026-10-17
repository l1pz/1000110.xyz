import { buttonRow, lineInput, statusLine, textInput, toggleButton } from "../../ui";
import { explain } from "./explain";
import { FLAGS, type Match, RegexError, runRegex, segments } from "./run";

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ""): HTMLElementTagNameMap[K] {
    const n = document.createElement(tag);
    n.className = className;
    n.textContent = text;
    return n;
}

const show = (value: string | undefined) => (value === undefined ? "(no match)" : JSON.stringify(value));

function describeMatches(matches: Match[]): string {
    return matches
        .map((m, i) => {
            const head = `#${i + 1} at ${m.index}: ${JSON.stringify(m.text)}`;
            const groups = m.groups.map((g, n) => `\n    ${n + 1}: ${show(g)}`);
            const named = Object.entries(m.named).map(([k, v]) => `\n    ${k}: ${show(v)}`);
            return head + groups.join("") + named.join("");
        })
        .join("\n");
}

export function mount(el: HTMLElement): void {
    const flags = new Set(["g"]);
    const pattern = lineInput("pattern", "e.g. (\\d+)-(\\d+)");
    const text = textInput("test text", "text to search");
    const marked = node("pre", "regex-marked");
    const list = node("pre", "regex-matches");
    const steps = node("pre", "regex-explain");
    const status = statusLine();

    const update = () => {
        const flagString = FLAGS.filter((f) => flags.has(f.id))
            .map((f) => f.id)
            .join("");
        steps.replaceChildren(
            ...explain(pattern.input.value).map((s) => {
                const row = node("span", "");
                row.append(
                    `${"  ".repeat(s.depth)}${s.token}`.padEnd(14 + s.depth * 2),
                    node("span", "dim", ` ${s.meaning}\n`),
                );
                return row;
            }),
        );
        try {
            const { matches, total } = runRegex(pattern.input.value, flagString, text.input.value);
            marked.replaceChildren(
                ...segments(text.input.value, matches).map((s) =>
                    s.match === undefined ? document.createTextNode(s.text) : node("mark", "hit", s.text),
                ),
            );
            list.textContent = describeMatches(matches);
            status.set(
                pattern.input.value
                    ? `${total} match${total === 1 ? "" : "es"}${total > matches.length ? `, showing ${matches.length}` : ""}`
                    : "",
            );
        } catch (err) {
            if (!(err instanceof RegexError)) throw err;
            marked.replaceChildren(document.createTextNode(text.input.value));
            list.textContent = "";
            status.set(`error: ${err.message}`, true);
        }
    };

    pattern.input.addEventListener("input", update);
    text.input.addEventListener("input", update);
    el.append(
        pattern.wrap,
        buttonRow(
            ...FLAGS.map((f) =>
                toggleButton(f.label, flags.has(f.id), (on) => {
                    if (on) flags.add(f.id);
                    else flags.delete(f.id);
                    update();
                }),
            ),
        ),
        text.wrap,
        marked,
        status.node,
        list,
        steps,
    );
    update();
}
