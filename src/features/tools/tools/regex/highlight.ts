import { token } from "../../../../core/highlight/tokens";
import { escapeHtml } from "../../../../core/html";
import { explain, type StepKind } from "./explain";

const CLASS: Record<StepKind, string> = {
    escape: "tok-esc",
    class: "tok-class",
    group: "tok-group",
    quantifier: "tok-quant",
    alternation: "tok-group",
    anchor: "tok-kw",
    any: "tok-kw",
    literal: "",
};

/** Colors a regex pattern part by part (groups, classes, escapes, quantifiers, anchors), reusing the explainer's reader. */
export function highlightRegex(pattern: string): string {
    return explain(pattern)
        .map((s) => (CLASS[s.kind] ? token(CLASS[s.kind], s.token) : escapeHtml(s.token)))
        .join("");
}
