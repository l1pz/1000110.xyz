/** Small DOM helpers shared by tools. Styles are in `styles/tools.css`. Only used from `mount`, so logic stays testable. */
import { refuseFile } from "./files";
import { publicTools } from "./registry";
import { createToolState, putPipe, splitHash, type ToolState } from "./state";

/** The browser stores, or `null` where access is blocked (private windows, blocked site data). */
function storage(kind: "localStorage" | "sessionStorage"): Storage | null {
    try {
        return window[kind];
    } catch {
        return null;
    }
}

/** State for the tool `id`: URL values, remembered options, the "send to" handoff (see `state.ts`). Call once, at the top of `mount`. */
export function toolState(id: string): ToolState {
    return createToolState(id, location.hash, storage("localStorage"), storage("sessionStorage"));
}

/** Flashes `text` on a button for a moment, then restores its label. */
function flash(btn: HTMLButtonElement, text: string): void {
    const label = btn.dataset.label ?? btn.textContent ?? "";
    btn.dataset.label = label;
    btn.textContent = text;
    setTimeout(() => {
        btn.textContent = label;
    }, 1500);
}

/** "copy link": copies a URL that reproduces the tool's input and options. Text over the link limit is left out and said so. */
export function linkButton(state: ToolState): HTMLButtonElement {
    const btn = button("copy link", async () => {
        const { hash, dropped } = state.link();
        const url = `${location.origin}${location.pathname}${hash}`;
        try {
            await navigator.clipboard.writeText(url);
            flash(btn, dropped.length ? "copied, long text left out" : "copied");
        } catch {
            location.hash = hash; // clipboard blocked: the address bar now holds the link
            flash(btn, "link is in the address bar");
        }
    });
    return btn;
}

function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
    props: Partial<HTMLElementTagNameMap[K]> = {},
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.className = className;
    return Object.assign(node, props);
}

/**
 * A labelled multi-line text input with a "paste" button. A dropped text file is loaded into it (`drop: false`
 * turns that off for tools that need the raw bytes of a file instead).
 */
export function textInput(
    label: string,
    placeholder = "",
    { drop = true }: { drop?: boolean } = {},
): { wrap: HTMLElement; input: HTMLTextAreaElement } {
    const wrap = el("div", "field");
    const text = el("label", "dim", { textContent: label });
    const input = el("textarea", "", { placeholder, rows: 6, spellcheck: false });
    input.autocapitalize = "off";
    text.append(input);
    const note = (message: string, error = false) => {
        hint.textContent = message;
        hint.classList.toggle("error", error);
    };
    const load = (value: string) => {
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const pasteBtn = button("paste", async () => {
        try {
            load(await navigator.clipboard.readText());
            note("");
        } catch {
            input.focus(); // clipboard blocked: the usual paste still works
            note("clipboard blocked: paste with Ctrl+V or the long-press menu");
        }
    });
    const hint = el("span", "dim hint");
    wrap.append(text, pasteBtn, hint);
    if (drop) {
        input.addEventListener("dragover", (e) => e.preventDefault());
        input.addEventListener("drop", async (e) => {
            const file = e.dataTransfer?.files[0];
            if (!file) return;
            e.preventDefault();
            const body = file.size > 2_000_000 ? "" : await file.text();
            const why = refuseFile(file.size, body);
            if (why) note(why, true);
            else {
                load(body);
                note(`loaded ${file.name}`);
            }
        });
    }
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

/** A labelled read-only result box with a copy button, and (`send: true`) a "send to" picker of the other text tools. */
export function outputBox(
    label: string,
    rows = 6,
    { send = false }: { send?: boolean } = {},
): { wrap: HTMLElement; set: (text: string) => void } {
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
    if (send) {
        const here = splitHash(location.hash).id;
        const picker = el("div", "buttons");
        picker.hidden = true;
        picker.append(
            ...publicTools()
                .filter((t) => t.pipe && t.id !== here)
                .map((t) =>
                    button(t.id, () => {
                        if (box.value === "") return flash(copy, "nothing to send");
                        if (!putPipe(storage("sessionStorage"), box.value)) return flash(copy, "storage blocked");
                        location.hash = `#${encodeURIComponent(t.id)}`;
                    }),
                ),
        );
        const sendBtn = button("send to", () => {
            picker.hidden = !picker.hidden;
            sendBtn.classList.toggle("active", !picker.hidden);
        });
        wrap.append(sendBtn, picker);
    }
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
