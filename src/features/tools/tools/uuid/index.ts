import { button, buttonRow, modePicker, numberInput, outputBox, statusLine, toggleButton, toolState } from "../../ui";
import { generate, KINDS, type Kind, NANOID, type Options } from "./generate";

const COUNTS = [
    { id: "1", label: "1" },
    { id: "5", label: "5" },
    { id: "10", label: "10" },
] as const;

export function mount(el: HTMLElement): void {
    // Only options are remembered (nothing here is worth a link: the output is random).
    const state = toolState("uuid");
    const options: Options = {
        kind: state.get(
            "k",
            "uuid4",
            KINDS.map((k) => k.id),
        ) as Kind,
        count: Number(
            state.get(
                "n",
                "1",
                COUNTS.map((c) => c.id),
            ),
        ),
        upper: state.get("u", "0", ["0", "1"]) === "1",
        hyphens: state.get("h", "1", ["0", "1"]) === "1",
        size: state.getNumber("sz", NANOID.size, NANOID.min, NANOID.max),
    };

    const controls = document.createElement("div");
    const out = outputBox("result", 6);
    const status = statusLine();

    const run = () => {
        try {
            out.set(generate(options));
            status.set("");
        } catch (err) {
            if (!(err instanceof RangeError)) throw err;
            out.set("");
            status.set(`error: ${err.message}`, true);
        }
    };

    // Rebuilt when the kind changes, because each kind has its own options.
    const renderControls = () => {
        const parts: HTMLElement[] = [];
        if (options.kind === "nanoid") {
            const size = numberInput("length", options.size, NANOID.min, NANOID.max, () => {
                options.size = size.get();
                state.set("sz", String(options.size));
                run();
            });
            parts.push(size.wrap);
        } else if (options.kind !== "ulid") {
            parts.push(
                buttonRow(
                    toggleButton("UPPER", options.upper, (on) => {
                        options.upper = on;
                        state.set("u", on ? "1" : "0");
                        run();
                    }),
                    toggleButton("hyphens", options.hyphens, (on) => {
                        options.hyphens = on;
                        state.set("h", on ? "1" : "0");
                        run();
                    }),
                ),
            );
        }
        controls.replaceChildren(...parts);
    };

    el.append(
        modePicker(KINDS, options.kind, (id: Kind) => {
            options.kind = id;
            state.set("k", id);
            renderControls();
            run();
        }),
        modePicker(COUNTS, String(options.count), (id) => {
            options.count = Number(id);
            state.set("n", id);
            run();
        }),
        controls,
        out.wrap,
        status.node,
        buttonRow(button("regenerate", run)),
    );
    renderControls();
    run();
}
