import { buttonRow, linkButton, textInput, toolState } from "../../ui";
import { rows } from "./count";

export function mount(el: HTMLElement): void {
    const state = toolState("count");
    const { wrap, input } = textInput("input", "type or paste text");
    state.bindText("i", input, { primary: true });
    input.rows = 10;
    const table = document.createElement("dl");
    table.className = "stats";

    const update = () => {
        table.replaceChildren(
            ...rows(input.value).flatMap(([label, value]) => {
                const dt = document.createElement("dt");
                dt.className = "dim";
                dt.textContent = label;
                const dd = document.createElement("dd");
                dd.textContent = value;
                return [dt, dd];
            }),
        );
    };

    input.addEventListener("input", update);
    el.append(wrap, table, buttonRow(linkButton(state)));
    update();
}
