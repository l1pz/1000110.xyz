import { buttonRow, linkButton, modePicker, outputBox, textInput, toolState } from "../../ui";
import { type CaseMode, convertCase, MODES } from "./convert";

export function mount(el: HTMLElement): void {
    const state = toolState("case");
    let mode = state.get(
        "m",
        "snake",
        MODES.map((m) => m.id),
    ) as CaseMode;
    const { wrap, input } = textInput("input", "type or paste text");
    state.bindText("i", input, { primary: true });
    const out = outputBox("output", 6, { send: true });
    const update = () => out.set(convertCase(input.value, mode));

    const picker = modePicker(MODES, mode, (id) => {
        mode = id;
        state.set("m", id);
        update();
    });
    input.addEventListener("input", update);
    el.append(wrap, picker, out.wrap, buttonRow(linkButton(state)));
    update();
}
