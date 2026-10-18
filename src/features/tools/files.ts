/** Rules for text files dropped on a tool. Pure, so tests call them directly. */

/** Largest file a text box takes (bytes). */
export const FILE_LIMIT = 1_000_000;

/** True for text that is probably a binary file read as text: a NUL byte, or many U+FFFD replacement characters. */
export function looksBinary(text: string): boolean {
    const head = text.slice(0, 8000);
    if (head.includes("\0")) return true;
    const bad = head.split("�").length - 1;
    return head.length > 0 && bad / head.length > 0.01;
}

/** Why a dropped file is refused, or `null` when it is fine (`text` is the file read as text). */
export function refuseFile(size: number, text: string): string | null {
    if (size > FILE_LIMIT) return `file too big (${FILE_LIMIT / 1_000_000} MB max)`;
    if (looksBinary(text)) return "not a text file";
    return null;
}
