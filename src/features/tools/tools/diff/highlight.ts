import { token } from "../../../../core/highlight/tokens";
import type { DiffLine } from "./diff";

const MARK = { same: "  ", add: "+ ", del: "- " } as const;
const CLASS = { same: "tok-same", add: "tok-add", del: "tok-del" } as const;

/** The diff as colored text, one line per entry: `+ added` green, `- removed` red, unchanged gray. */
export function highlightDiff(lines: DiffLine[]): string {
    return lines.map((l) => `${token(CLASS[l.kind], `${MARK[l.kind]}${l.text}`)}\n`).join("");
}
