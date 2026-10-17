import { buttonRow, statusLine, textInput, toggleButton } from "../../ui";
import { DiffTooBig, diffLines, summary } from "./diff";

const MARK = { same: "  ", add: "+ ", del: "- " } as const;

export function mount(el: HTMLElement): void {
    const options = { ignoreCase: false, ignoreSpace: false };
    const left = textInput("original", "old text");
    const right = textInput("changed", "new text");
    const result = document.createElement("pre");
    result.className = "diff";
    const status = statusLine();

    const update = () => {
        try {
            const diff = diffLines(left.input.value, right.input.value, options);
            result.replaceChildren(
                ...diff.map((line) => {
                    const row = document.createElement("span");
                    row.className = `diff-${line.kind}`;
                    row.textContent = `${MARK[line.kind]}${line.text}\n`;
                    return row;
                }),
            );
            status.set(left.input.value || right.input.value ? summary(diff) : "");
        } catch (err) {
            if (!(err instanceof DiffTooBig)) throw err;
            result.replaceChildren();
            status.set(`error: ${err.message}`, true);
        }
    };

    left.input.addEventListener("input", update);
    right.input.addEventListener("input", update);
    el.append(
        left.wrap,
        right.wrap,
        buttonRow(
            toggleButton("ignore case", false, (on) => {
                options.ignoreCase = on;
                update();
            }),
            toggleButton("ignore spaces", false, (on) => {
                options.ignoreSpace = on;
                update();
            }),
        ),
        result,
        status.node,
    );
}
