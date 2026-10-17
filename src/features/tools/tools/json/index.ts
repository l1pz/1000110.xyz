import { modePicker, outputBox, statusLine, textInput, toggleButton } from "../../ui";
import { formatJson, INDENTS, type Indent, JsonError, type JsonMode, MODES } from "./format";

export function mount(el: HTMLElement): void {
    const options = { mode: "format" as JsonMode, indent: "2" as Indent, sortKeys: false };
    const { wrap, input } = textInput("input", "paste JSON");
    const out = outputBox("output", 10);
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
            update();
        }),
        modePicker(INDENTS, options.indent, (id) => {
            options.indent = id;
            update();
        }),
        toggleButton("sort keys", false, (on) => {
            options.sortKeys = on;
            update();
        }),
        out.wrap,
        status.node,
    );
}
