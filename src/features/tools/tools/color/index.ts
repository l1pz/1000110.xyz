import { button, buttonRow, lineInput, linkButton, statusLine, toolState } from "../../ui";
import { contrastRows, conversionRows, parseColor, type Rgb, toHex } from "./color";

function table(rows: [string, string][]): Node[] {
    return rows.flatMap(([label, value]) => {
        const dt = document.createElement("dt");
        dt.className = "dim";
        dt.textContent = label;
        const dd = document.createElement("dd");
        dd.textContent = value;
        return [dt, dd];
    });
}

function swatch(): HTMLElement {
    const node = document.createElement("div");
    node.className = "swatch";
    node.setAttribute("aria-hidden", "true");
    return node;
}

export function mount(el: HTMLElement): void {
    // converter
    const one = lineInput("color", "#fabd2f, rgb(250, 189, 47) or hsl(42, 95%, 58%)");
    one.input.value = "#fabd2f";
    const state = toolState("color");
    state.bindText("c", one.input);
    const oneStatus = statusLine();
    const oneSwatch = swatch();
    const oneTable = document.createElement("dl");
    oneTable.className = "stats";

    const updateOne = () => {
        const c = parseColor(one.input.value);
        const empty = one.input.value.trim() === "";
        oneStatus.set(c || empty ? "" : "not a color (hex, rgb or hsl)", !c && !empty);
        oneSwatch.style.background = c ? toHex(c) : "transparent";
        oneTable.replaceChildren(...(c ? table(conversionRows(c)) : []));
    };
    one.input.addEventListener("input", updateOne);

    // contrast
    const fg = lineInput("text color", "#ebdbb2");
    fg.input.value = "#ebdbb2";
    const bg = lineInput("background color", "#282828");
    bg.input.value = "#282828";
    state.bindText("f", fg.input);
    state.bindText("b", bg.input);
    const twoStatus = statusLine();
    const sample = document.createElement("div");
    sample.className = "swatch sample";
    sample.textContent = "The quick brown fox";
    const twoTable = document.createElement("dl");
    twoTable.className = "stats";

    const updateTwo = () => {
        const f: Rgb | null = parseColor(fg.input.value);
        const b: Rgb | null = parseColor(bg.input.value);
        if (!f || !b) {
            const anyText = fg.input.value.trim() !== "" && bg.input.value.trim() !== "";
            twoStatus.set(anyText ? "not a color (hex, rgb or hsl)" : "", anyText);
            twoTable.replaceChildren();
            return;
        }
        twoStatus.set("");
        sample.style.color = toHex(f);
        sample.style.background = toHex(b);
        twoTable.replaceChildren(...table(contrastRows(f, b)));
    };
    fg.input.addEventListener("input", updateTwo);
    bg.input.addEventListener("input", updateTwo);
    const swap = button("swap", () => {
        [fg.input.value, bg.input.value] = [bg.input.value, fg.input.value];
        updateTwo();
    });

    el.append(
        one.wrap,
        oneStatus.node,
        oneSwatch,
        oneTable,
        fg.wrap,
        bg.wrap,
        buttonRow(swap, linkButton(state)),
        twoStatus.node,
        sample,
        twoTable,
    );
    updateOne();
    updateTwo();
}
