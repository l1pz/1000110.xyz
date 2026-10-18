import { button, buttonRow, linkButton, modePicker, outputBox, statusLine, textInput, toolState } from "../../ui";
import { CODECS, CodecError, type CodecId, type Direction, getCodec, run } from "./codec";

const DIRECTIONS = [
    { id: "encode", label: "encode" },
    { id: "decode", label: "decode" },
] as const;

export function mount(el: HTMLElement): void {
    const state = toolState("encode");
    let codecId = state.get(
        "c",
        "base64",
        CODECS.map((c) => c.id),
    ) as CodecId;
    let direction = state.get(
        "d",
        "encode",
        DIRECTIONS.map((d) => d.id),
    ) as Direction;
    const variants = getCodec(codecId).variants;
    let variant = state.get("v", "", (v) => v === "" || !!variants?.some((x) => x.id === v));
    let lastOk: string | null = null;

    const { wrap, input } = textInput("input", "type or paste text");
    state.bindText("i", input, { primary: true });
    const controls = document.createElement("div");
    const out = outputBox("output", 6, { send: true });
    const status = statusLine();

    const update = () => {
        try {
            const result = run(codecId, direction, input.value, variant);
            lastOk = result.text;
            out.set(result.text);
            status.set(result.note ?? "");
        } catch (err) {
            if (!(err instanceof CodecError)) throw err;
            lastOk = null;
            out.set("");
            status.set(`error: ${err.message}`, true);
        }
    };

    // The pickers are rebuilt on every change so the active buttons follow the state (also after a swap).
    const renderControls = () => {
        const codec = getCodec(codecId);
        const parts: HTMLElement[] = [
            modePicker(CODECS, codecId, (id) => {
                codecId = id;
                variant = "";
                state.set("c", id);
                state.set("v", "");
                renderControls();
                update();
            }),
        ];
        if (codec.variants) {
            parts.push(
                modePicker(codec.variants, variant || codec.variants[0].id, (id) => {
                    variant = id;
                    state.set("v", id);
                    update();
                }),
            );
        }
        parts.push(
            modePicker(DIRECTIONS, direction, (id) => {
                direction = id;
                state.set("d", id);
                update();
            }),
        );
        controls.replaceChildren(...parts);
    };

    const swap = button("use output as input", () => {
        if (lastOk === null) return;
        input.value = lastOk;
        direction = direction === "encode" ? "decode" : "encode";
        state.set("d", direction);
        renderControls();
        update();
    });

    input.addEventListener("input", update);
    el.append(wrap, controls, out.wrap, status.node, buttonRow(swap, linkButton(state)));
    renderControls();
    update();
}
