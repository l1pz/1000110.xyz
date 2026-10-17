import { buttonRow, linkButton, statusLine, textInput, toggleButton, toolState } from "../../ui";
import { DiffTooBig, diffLines, summary } from "./diff";

const MARK = { same: "  ", add: "+ ", del: "- " } as const;

export function mount(el: HTMLElement): void {
    const state = toolState("diff");
    const options = {
        ignoreCase: state.get("c", "0", ["0", "1"]) === "1",
        ignoreSpace: state.get("s", "0", ["0", "1"]) === "1",
    };
    const left = textInput("original", "old text");
    const right = textInput("changed", "new text");
    state.bindText("a", left.input, { primary: true });
    state.bindText("b", right.input);
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
            toggleButton("ignore case", options.ignoreCase, (on) => {
                options.ignoreCase = on;
                state.set("c", on ? "1" : "0");
                update();
            }),
            toggleButton("ignore spaces", options.ignoreSpace, (on) => {
                options.ignoreSpace = on;
                state.set("s", on ? "1" : "0");
                update();
            }),
            linkButton(state),
        ),
        result,
        status.node,
    );
    update();
}
