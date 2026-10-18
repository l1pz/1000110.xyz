import { button, buttonRow, lineInput, linkButton, statusLine, toolState } from "../../ui";
import { DEFAULT_ZONES, isValidZone, localZone, parseInput, rows } from "./time";

export function mount(el: HTMLElement): void {
    const when = lineInput("timestamp or date", "1700000000, 2024-03-10T12:00:00Z or now");
    when.input.value = "now";
    const state = toolState("time");
    state.bindText("t", when.input);
    const zone = lineInput("extra time zone (IANA name)", "Europe/London");
    state.bindText("z", zone.input);
    const status = statusLine();
    const table = document.createElement("dl");
    table.className = "stats wide";

    const update = () => {
        const extra = zone.input.value.trim();
        const parsed = parseInput(when.input.value, Date.now());
        if (typeof parsed === "string") {
            table.replaceChildren();
            status.set(parsed, parsed !== "");
            return;
        }
        const bad = extra !== "" && !isValidZone(extra);
        status.set(bad ? `unknown time zone: ${extra}` : parsed.note, bad);
        const zones = [localZone(), ...DEFAULT_ZONES, ...(extra && !bad ? [extra] : [])];
        table.replaceChildren(
            ...rows(parsed.ms, [...new Set(zones)]).flatMap(([label, value]) => {
                const dt = document.createElement("dt");
                dt.className = "dim";
                dt.textContent = label;
                const dd = document.createElement("dd");
                dd.textContent = value;
                return [dt, dd];
            }),
        );
    };

    when.input.addEventListener("input", update);
    zone.input.addEventListener("input", update);
    const now = button("now", () => {
        when.input.value = "now";
        update();
    });
    el.append(when.wrap, buttonRow(now, linkButton(state)), zone.wrap, status.node, table);
    update();
}
