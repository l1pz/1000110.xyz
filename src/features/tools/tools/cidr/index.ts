import { buttonRow, lineInput, linkButton, statusLine, toolState } from "../../ui";
import { calculate, rows } from "./cidr";

export function mount(el: HTMLElement): void {
    const { wrap, input } = lineInput("address / prefix", "192.168.1.10/24 or 2001:db8::/32");
    input.value = "192.168.1.10/24";
    const state = toolState("cidr");
    state.bindText("a", input);
    const status = statusLine();
    const table = document.createElement("dl");
    table.className = "stats";

    const update = () => {
        const result = calculate(input.value);
        if (typeof result === "string") {
            table.replaceChildren();
            status.set(result, result !== "");
            return;
        }
        status.set("");
        table.replaceChildren(
            ...rows(result).flatMap(([label, value]) => {
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
    el.append(wrap, status.node, table, buttonRow(linkButton(state)));
    update();
}
