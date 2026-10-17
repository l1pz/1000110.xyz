/** Small DOM helpers shared by tools. Styles are in `styles/tools.css`. Only used from `mount`, so logic stays testable. */

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
    props: Partial<HTMLElementTagNameMap[K]> = {},
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.className = className;
    return Object.assign(node, props);
}

/** A labelled multi-line text input. */
export function textInput(label: string, placeholder = ""): { wrap: HTMLElement; input: HTMLTextAreaElement } {
    const wrap = el("label", "field");
    const text = el("span", "dim", { textContent: label });
    const input = el("textarea", "", { placeholder, rows: 6, spellcheck: false });
    input.autocapitalize = "off";
    wrap.append(text, input);
    return { wrap, input };
}

/** A labelled single-line text input. */
export function lineInput(label: string, placeholder = ""): { wrap: HTMLElement; input: HTMLInputElement } {
    const wrap = el("label", "field");
    const text = el("span", "dim", { textContent: label });
    const input = el("input", "", { type: "text", placeholder, spellcheck: false });
    input.autocapitalize = "off";
    input.autocomplete = "off";
    wrap.append(text, input);
    return { wrap, input };
}

/** A labelled whole-number input; `get()` is the current value clamped to `[min, max]` (the box keeps what was typed). */
export function numberInput(
    label: string,
    value: number,
    min: number,
    max: number,
    onChange: () => void,
): { wrap: HTMLElement; get: () => number } {
    const wrap = el("label", "field");
    const text = el("span", "dim", { textContent: `${label} (${min}-${max})` });
    const input = el("input", "", {
        type: "number",
        value: String(value),
        min: String(min),
        max: String(max),
        step: "1",
    });
    input.inputMode = "numeric";
    input.addEventListener("input", onChange);
    wrap.append(text, input);
    return {
        wrap,
        get: () => Math.min(max, Math.max(min, Math.round(Number(input.value)) || min)),
    };
}

/** A button that flips between on and off (`active` class) and reports the new state. */
export function toggleButton(label: string, initial: boolean, onChange: (on: boolean) => void): HTMLButtonElement {
    let on = initial;
    const btn = button(label, () => {
        on = !on;
        btn.classList.toggle("active", on);
        onChange(on);
    });
    btn.classList.toggle("active", on);
    return btn;
}

/** A labelled read-only result box with a copy button. */
export function outputBox(label: string, rows = 6): { wrap: HTMLElement; set: (text: string) => void } {
    const wrap = el("div", "field");
    const text = el("span", "dim", { textContent: label });
    const box = el("textarea", "", { readOnly: true, rows, spellcheck: false });
    const copy = button("copy", async () => {
        try {
            await navigator.clipboard.writeText(box.value);
            copy.textContent = "copied";
        } catch {
            box.select(); // clipboard blocked: leave the text selected for a manual copy
            copy.textContent = "select + copy";
        }
        setTimeout(() => {
            copy.textContent = "copy";
        }, 1500);
    });
    wrap.append(text, box, copy);
    return {
        wrap,
        set: (value) => {
            box.value = value;
        },
    };
}

export function button(label: string, onClick: () => void): HTMLButtonElement {
    return el("button", "btn", { type: "button", textContent: label, onclick: onClick });
}

/** A wrapping row for plain action buttons. */
export function buttonRow(...buttons: HTMLButtonElement[]): HTMLElement {
    const row = el("div", "buttons");
    row.append(...buttons);
    return row;
}

/** One line under a result: a dim note, or a red error. Empty text hides it. */
export function statusLine(): { node: HTMLElement; set: (text: string, error?: boolean) => void } {
    const node = el("p", "status dim");
    return {
        node,
        set: (text, error = false) => {
            node.textContent = text;
            node.classList.toggle("error", error);
        },
    };
}

/** A wrapping row of buttons where exactly one is `active` (a mode picker). */
export function modePicker<T extends string>(
    modes: readonly { id: T; label: string }[],
    initial: T,
    onPick: (id: T) => void,
): HTMLElement {
    const row = el("div", "buttons");
    const buttons: HTMLButtonElement[] = modes.map((m) =>
        button(m.label, () => {
            buttons.forEach((b, i) => {
                b.classList.toggle("active", modes[i].id === m.id);
            });
            onPick(m.id);
        }),
    );
    buttons.forEach((b, i) => {
        b.classList.toggle("active", modes[i].id === initial);
    });
    row.append(...buttons);
    return row;
}
