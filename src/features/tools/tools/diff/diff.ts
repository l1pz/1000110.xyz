export type DiffKind = "same" | "add" | "del";

export interface DiffLine {
    kind: DiffKind;
    text: string;
}

export interface DiffOptions {
    ignoreCase: boolean;
    ignoreSpace: boolean;
}

/** The line table is `old x new` cells; above this the tool refuses instead of freezing the tab. */
export const MAX_CELLS = 4_000_000;

export class DiffTooBig extends Error {}

const lines = (text: string) => (text === "" ? [] : text.split(/\r\n|\r|\n/));

/** The key two lines are compared by. The shown text is always the original. */
function keyOf(line: string, { ignoreCase, ignoreSpace }: DiffOptions): string {
    let key = line;
    if (ignoreSpace) key = key.replace(/\s+/g, " ").trim();
    if (ignoreCase) key = key.toLowerCase();
    return key;
}

/**
 * Line diff of `a` against `b`: common start and end are peeled off, the middle goes through a longest common
 * subsequence table. Removed lines come before added ones inside one changed block. Throws `DiffTooBig`.
 */
export function diffLines(a: string, b: string, options: DiffOptions): DiffLine[] {
    const oldLines = lines(a);
    const newLines = lines(b);
    const oldKeys = oldLines.map((l) => keyOf(l, options));
    const newKeys = newLines.map((l) => keyOf(l, options));

    let start = 0;
    while (start < oldKeys.length && start < newKeys.length && oldKeys[start] === newKeys[start]) start++;
    let endOld = oldKeys.length;
    let endNew = newKeys.length;
    while (endOld > start && endNew > start && oldKeys[endOld - 1] === newKeys[endNew - 1]) {
        endOld--;
        endNew--;
    }

    const n = endOld - start;
    const m = endNew - start;
    if ((n + 1) * (m + 1) > MAX_CELLS) {
        throw new DiffTooBig(`texts differ too much to compare here (${n} x ${m} lines)`);
    }

    // table[i][j] = length of the common subsequence of the old tail from i and the new tail from j
    const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            table[i][j] =
                oldKeys[start + i] === newKeys[start + j]
                    ? table[i + 1][j + 1] + 1
                    : Math.max(table[i + 1][j], table[i][j + 1]);
        }
    }

    const out: DiffLine[] = newLines.slice(0, start).map((text) => ({ kind: "same", text }));
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
        if (i < n && j < m && oldKeys[start + i] === newKeys[start + j]) {
            out.push({ kind: "same", text: newLines[start + j] });
            i++;
            j++;
        } else if (i < n && (j === m || table[i + 1][j] >= table[i][j + 1])) {
            out.push({ kind: "del", text: oldLines[start + i] });
            i++;
        } else {
            out.push({ kind: "add", text: newLines[start + j] });
            j++;
        }
    }
    for (let k = endNew; k < newLines.length; k++) out.push({ kind: "same", text: newLines[k] });
    return out;
}

export function summary(diff: DiffLine[]): string {
    const added = diff.filter((l) => l.kind === "add").length;
    const removed = diff.filter((l) => l.kind === "del").length;
    return added + removed === 0 ? "identical" : `+${added} -${removed}`;
}
