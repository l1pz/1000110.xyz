import { lineInput, modePicker, outputBox, textInput } from "../../ui";
import { ALGORITHMS, type AlgorithmId, hashAll, hashText } from "./digest";

type Pick = AlgorithmId | "all";

const PICKS = [...ALGORITHMS.map((a) => ({ id: a.id, label: a.label })), { id: "all", label: "all" }] as const;
const CASES = [
    { id: "lower", label: "lower" },
    { id: "upper", label: "UPPER" },
] as const;

export function mount(el: HTMLElement): void {
    let pick: Pick = "sha256";
    let upper = false;
    let latest = 0;

    const { wrap, input } = textInput("input", "type or paste text");
    const key = lineInput("HMAC key (optional)", "empty = plain hash");
    const out = outputBox("hash");

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
            void update();
        }),
        modePicker(CASES, "lower", (id) => {
            upper = id === "upper";
            void update();
        }),
        out.wrap,
    );
    input.addEventListener("input", () => void update());
    key.input.addEventListener("input", () => void update());
    void update();
}
