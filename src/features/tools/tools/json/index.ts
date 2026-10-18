import { highlightJson } from "../../../../core/highlight/json";
import { escapeHtml } from "../../../../core/html";
import { buttonRow, linkButton, modePicker, outputBox, statusLine, textInput, toggleButton, toolState } from "../../ui";
import { formatJson, INDENTS, type Indent, JsonError, type JsonMode, MODES } from "./format";

/** Past this size coloring on every keystroke would lag, so the text is shown plain. */
const COLOR_LIMIT = 200_000;
const color = (text: string) => (text.length > COLOR_LIMIT ? escapeHtml(text) : highlightJson(text));

export function mount(el: HTMLElement): void {
    const state = toolState("json");
    const options = {
        mode: state.get(
            "m",
            "format",
            MODES.map((m) => m.id),
        ) as JsonMode,
        indent: state.get(
            "x",
            "2",
            INDENTS.map((m) => m.id),
        ) as Indent,
        sortKeys: state.get("s", "0", ["0", "1"]) === "1",
    };
    const { wrap, input } = textInput("input", "paste JSON", { colorer: color });
    state.bindText("i", input, { primary: true });
    const out = outputBox("output", 10, { send: true, colorer: color });
    const status = statusLine();

    const update = () => {
        try {
            out.set(formatJson(input.value, options));
            status.set(input.value.trim() ? "ok" : "");
        } catch (err) {
            if (!(err instanceof JsonError)) throw err;
            out.set("");
            status.set(`error: ${err.message}`, true);
        }
    };

    input.addEventListener("input", update);
    el.append(
        wrap,
        modePicker(MODES, options.mode, (id) => {
            options.mode = id;
            state.set("m", id);
            update();
        }),
        modePicker(INDENTS, options.indent, (id) => {
            options.indent = id;
            state.set("x", id);
            update();
        }),
        toggleButton("sort keys", options.sortKeys, (on) => {
            options.sortKeys = on;
            state.set("s", on ? "1" : "0");
            update();
        }),
        out.wrap,
        status.node,
        buttonRow(linkButton(state)),
    );
    update();
}
