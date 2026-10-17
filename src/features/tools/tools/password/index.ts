import { button, buttonRow, modePicker, numberInput, outputBox, statusLine, toggleButton } from "../../ui";
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
    let mode: Mode = "password";
    const password: PasswordOptions = {
        length: 20,
        classes: { lower: true, upper: true, digits: true, symbols: true },
        avoidAmbiguous: false,
    };
    const phrase: PassphraseOptions = { words: 5, separator: "-", capitalize: false, digit: false };

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
            generate();
        });
        const classes = (Object.keys(CLASSES) as CharClass[]).map((name) =>
            toggleButton(name, password.classes[name], (on) => {
                password.classes[name] = on;
                generate();
            }),
        );
        const ambiguous = toggleButton("no look-alikes (Il1|O0o)", password.avoidAmbiguous, (on) => {
            password.avoidAmbiguous = on;
            generate();
        });
        return [length.wrap, buttonRow(...classes), buttonRow(ambiguous)];
    };

    const passphraseControls = (): HTMLElement[] => {
        const words = numberInput("words", phrase.words, LIMITS.minWords, LIMITS.maxWords, () => {
            phrase.words = words.get();
            generate();
        });
        const separator = modePicker(SEPARATORS, phrase.separator, (id) => {
            phrase.separator = id;
            generate();
        });
        const capitalize = toggleButton("Capitalize", phrase.capitalize, (on) => {
            phrase.capitalize = on;
            generate();
        });
        const digit = toggleButton("add a digit", phrase.digit, (on) => {
            phrase.digit = on;
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
