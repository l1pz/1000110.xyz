import { button, buttonRow, modePicker, numberInput, outputBox, statusLine, toggleButton, toolState } from "../../ui";
import {
    type CharClass,
    CLASSES,
    generatePassphrase,
    generatePassword,
    LIMITS,
    meter,
    type PassphraseOptions,
    type PasswordOptions,
} from "./generate";

type Mode = "password" | "passphrase";

const MODES = [
    { id: "password", label: "password" },
    { id: "passphrase", label: "passphrase" },
] as const;

const SEPARATORS = [
    { id: "-", label: "-" },
    { id: " ", label: "space" },
    { id: ".", label: "." },
    { id: "_", label: "_" },
    { id: "", label: "none" },
] as const;

export function mount(el: HTMLElement): void {
    // Only options are remembered (nothing here is worth a link: the output is random).
    const state = toolState("password");
    const flag = (key: string, fallback: boolean) => state.get(key, fallback ? "1" : "0", ["0", "1"]) === "1";
    let mode = state.get(
        "m",
        "password",
        MODES.map((m) => m.id),
    ) as Mode;
    const password: PasswordOptions = {
        length: state.getNumber("len", 20, LIMITS.minLength, LIMITS.maxLength),
        classes: {
            lower: flag("lower", true),
            upper: flag("upper", true),
            digits: flag("digits", true),
            symbols: flag("symbols", true),
        },
        avoidAmbiguous: flag("amb", false),
    };
    const phrase: PassphraseOptions = {
        words: state.getNumber("words", 5, LIMITS.minWords, LIMITS.maxWords),
        separator: state.get(
            "sep",
            "-",
            SEPARATORS.map((s) => s.id),
        ),
        capitalize: flag("cap", false),
        digit: flag("dig", false),
    };

    const controls = document.createElement("div");
    const out = outputBox("result", 2);
    const status = statusLine();

    const generate = () => {
        try {
            const result = mode === "password" ? generatePassword(password) : generatePassphrase(phrase);
            out.set(result.text);
            status.set(meter(result.bits));
        } catch (err) {
            if (!(err instanceof RangeError)) throw err;
            out.set("");
            status.set(`error: ${err.message}`, true);
        }
    };

    const passwordControls = (): HTMLElement[] => {
        const length = numberInput("length", password.length, LIMITS.minLength, LIMITS.maxLength, () => {
            password.length = length.get();
            state.set("len", String(password.length));
            generate();
        });
        const classes = (Object.keys(CLASSES) as CharClass[]).map((name) =>
            toggleButton(name, password.classes[name], (on) => {
                password.classes[name] = on;
                state.set(name, on ? "1" : "0");
                generate();
            }),
        );
        const ambiguous = toggleButton("no look-alikes (Il1|O0o)", password.avoidAmbiguous, (on) => {
            password.avoidAmbiguous = on;
            state.set("amb", on ? "1" : "0");
            generate();
        });
        return [length.wrap, buttonRow(...classes), buttonRow(ambiguous)];
    };

    const passphraseControls = (): HTMLElement[] => {
        const words = numberInput("words", phrase.words, LIMITS.minWords, LIMITS.maxWords, () => {
            phrase.words = words.get();
            state.set("words", String(phrase.words));
            generate();
        });
        const separator = modePicker(SEPARATORS, phrase.separator, (id) => {
            phrase.separator = id;
            state.set("sep", id);
            generate();
        });
        const capitalize = toggleButton("Capitalize", phrase.capitalize, (on) => {
            phrase.capitalize = on;
            state.set("cap", on ? "1" : "0");
            generate();
        });
        const digit = toggleButton("add a digit", phrase.digit, (on) => {
            phrase.digit = on;
            state.set("dig", on ? "1" : "0");
            generate();
        });
        return [words.wrap, separator, buttonRow(capitalize, digit)];
    };

    const renderControls = () => {
        controls.replaceChildren(...(mode === "password" ? passwordControls() : passphraseControls()));
    };

    el.append(
        modePicker(MODES, mode, (id) => {
            mode = id;
            state.set("m", id);
            renderControls();
            generate();
        }),
        controls,
        out.wrap,
        status.node,
        buttonRow(button("regenerate", generate)),
    );
    renderControls();
    generate();
}
