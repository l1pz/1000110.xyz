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

/** Turns text into highlighted HTML; may be async (the generic languages load their chunk on first use). */
export type Colorer = (text: string) => string | Promise<string>;

/** Puts `html` into `pre`; a later call wins over an earlier one that is still loading. */
function paint(pre: HTMLElement, text: string, colorer: Colorer): void {
    const ticket = String(Number(pre.dataset.ticket ?? 0) + 1);
    pre.dataset.ticket = ticket;
    void Promise.resolve(colorer(text)).then(
        (html) => {
            if (pre.dataset.ticket === ticket) pre.innerHTML = html;
        },
        () => {
            if (pre.dataset.ticket === ticket) pre.textContent = text; // chunk failed to load: plain text
        },
    );
}

/**
 * Overlay highlighting for a textarea: a colored `<pre>` sits behind it with the same font, padding and wrapping, the
 * textarea text is transparent (the caret stays), and scrolling is mirrored. Returns the element to put in the page.
 */
function overlay(input: HTMLTextAreaElement, colorer: Colorer): HTMLElement {
    const box = el("div", "hl");
    const back = el("pre", "hl-back");
    back.setAttribute("aria-hidden", "true");
    box.append(back, input);
    const sync = () => {
        back.scrollTop = input.scrollTop;
        // A scrollbar in the textarea narrows its text; give the `<pre>` the same width so lines wrap alike.
        back.style.paddingRight = `calc(1ch + ${input.offsetWidth - input.clientWidth - 2}px)`;
    };
    const draw = () => {
        paint(back, `${input.value}\n`, colorer); // the extra newline gives a final empty line its height
        sync();
    };
    input.addEventListener("input", draw);
    input.addEventListener("scroll", sync);
    // Values set from code (paste, drop, links) fire "input" through `load` and `bindText`; this catches the rest.
    new ResizeObserver(sync).observe(input);
    queueMicrotask(draw);
    return box;
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
    { drop = true, colorer }: { drop?: boolean; colorer?: Colorer } = {},
): { wrap: HTMLElement; input: HTMLTextAreaElement } {
    const wrap = el("div", "field");
    const text = el("label", "dim", { textContent: label });
    const input = el("textarea", "", { placeholder, rows: 6, spellcheck: false });
    input.autocapitalize = "off";
    text.append(colorer ? overlay(input, colorer) : input);
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
    const wrap = el("div", "field");
    const text = el("span", "dim", { textContent: `${label} (${min}-${max})` });
    const input = el("input", "", {
        type: "number",
        value: String(value),
        min: String(min),
        max: String(max),
        step: "1",
    });
    input.inputMode = "numeric";
    input.setAttribute("aria-label", label);
    input.addEventListener("input", onChange);
    // Our own stepper instead of the browser's spinner arrows (hidden in tools.css); same clamping as `get`.
    const current = () => Math.min(max, Math.max(min, Math.round(Number(input.value)) || min));
    const step = (by: number) => {
        input.value = String(Math.min(max, Math.max(min, current() + by)));
        onChange();
    };
    const less = button("-", () => step(-1));
    const more = button("+", () => step(1));
    less.setAttribute("aria-label", `decrease ${label}`);
    more.setAttribute("aria-label", `increase ${label}`);
    const row = el("div", "stepper");
    row.append(less, input, more);
    wrap.append(text, row);
    return {
        wrap,
        get: current,
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
    { send = false, colorer }: { send?: boolean; colorer?: Colorer } = {},
): { wrap: HTMLElement; set: (text: string) => void } {
    const wrap = el("div", "field");
    const text = el("span", "dim", { textContent: label });
    // With a colorer the result is a highlighted <pre>; `raw` always holds the plain text that copy and "send to" use.
    const shown = colorer ? el("pre", "out") : null;
    const area = el("textarea", "", { readOnly: true, rows, spellcheck: false });
    let raw = "";
    const box = {
        get value() {
            return raw;
        },
        select: () => (shown ? getSelection()?.selectAllChildren(shown) : area.select()),
    };
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
    wrap.append(text, shown ?? area, copy);
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
            raw = value;
            if (shown && colorer) paint(shown, value, colorer);
            else area.value = value;
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
