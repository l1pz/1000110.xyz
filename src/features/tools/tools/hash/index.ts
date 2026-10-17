import { buttonRow, lineInput, linkButton, modePicker, outputBox, textInput, toolState } from "../../ui";
import { ALGORITHMS, type AlgorithmId, hashAll, hashText } from "./digest";

type Pick = AlgorithmId | "all";

const PICKS = [...ALGORITHMS.map((a) => ({ id: a.id, label: a.label })), { id: "all", label: "all" }] as const;
const CASES = [
    { id: "lower", label: "lower" },
    { id: "upper", label: "UPPER" },
] as const;

export function mount(el: HTMLElement): void {
    const state = toolState("hash");
    let pick = state.get(
        "a",
        "sha256",
        PICKS.map((p) => p.id),
    ) as Pick;
    let upper = state.get("u", "0", ["0", "1"]) === "1";
    let latest = 0;

    // Text only: a dropped file would be decoded as text and hash the wrong bytes (binary files come later).
    const { wrap, input } = textInput("input", "type or paste text", { drop: false });
    state.bindText("i", input, { primary: true });
    // The HMAC key is a secret: it is never put in a link.
    const key = lineInput("HMAC key (optional)", "empty = plain hash");
    const out = outputBox("hash", 6, { send: true });

    const update = async () => {
        const mine = ++latest;
        const text =
            pick === "all"
                ? await hashAll(input.value, key.input.value, upper)
                : await hashText(pick, input.value, key.input.value, upper);
        if (mine === latest) out.set(text); // a newer keystroke already started: drop this stale result
    };

    el.append(
        wrap,
        key.wrap,
        modePicker(PICKS, pick, (id) => {
            pick = id;
            state.set("a", id);
            void update();
        }),
        modePicker(CASES, upper ? "upper" : "lower", (id) => {
            upper = id === "upper";
            state.set("u", upper ? "1" : "0");
            void update();
        }),
        out.wrap,
        buttonRow(linkButton(state)),
    );
    input.addEventListener("input", () => void update());
    key.input.addEventListener("input", () => void update());
    void update();
}
