import { button, buttonRow, modePicker, numberInput, outputBox, statusLine, toggleButton } from "../../ui";
import { generate, KINDS, type Kind, NANOID, type Options } from "./generate";

const COUNTS = [
    { id: "1", label: "1" },
    { id: "5", label: "5" },
    { id: "10", label: "10" },
] as const;

export function mount(el: HTMLElement): void {
    const options: Options = { kind: "uuid4", count: 1, upper: false, hyphens: true, size: NANOID.size };

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
                run();
            });
            parts.push(size.wrap);
        } else if (options.kind !== "ulid") {
            parts.push(
                buttonRow(
                    toggleButton("UPPER", options.upper, (on) => {
                        options.upper = on;
                        run();
                    }),
                    toggleButton("hyphens", options.hyphens, (on) => {
                        options.hyphens = on;
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
            renderControls();
            run();
        }),
        modePicker(COUNTS, String(options.count), (id) => {
            options.count = Number(id);
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
