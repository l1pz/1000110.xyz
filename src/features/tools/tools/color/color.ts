export interface Rgb {
    r: number;
    g: number;
    b: number;
}

export interface Hsl {
    /** 0-360 */
    h: number;
    /** 0-100 */
    s: number;
    /** 0-100 */
    l: number;
}

const byte = (n: number) => Math.min(255, Math.max(0, Math.round(n)));

/**
 * Reads `#rgb`, `#rrggbb` (hash optional), `rgb(r, g, b)` / `r g b`, and `hsl(h, s%, l%)`.
 * Returns null when the text is none of these or a value is out of range.
 */
export function parseColor(text: string): Rgb | null {
    const t = text.trim().toLowerCase();
    const hex = t.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/);
    if (hex) {
        const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
        return {
            r: Number.parseInt(h.slice(0, 2), 16),
            g: Number.parseInt(h.slice(2, 4), 16),
            b: Number.parseInt(h.slice(4), 16),
        };
    }
    const fn = t.match(/^(rgb|hsl)a?\(\s*([^)]*?)\s*\)$/);
    const kind = fn ? fn[1] : /^[\d.\s,%]+$/.test(t) && t.includes("%") ? "hsl" : "rgb";
    const body = fn ? fn[2] : t;
    if (!/^[\d.\s,%]+$/.test(body)) return null;
    const nums = body.split(/[\s,]+/).filter(Boolean);
    if (nums.length !== 3) return null;
    const values = nums.map((n) => (/^\d+(\.\d+)?%?$/.test(n) ? Number.parseFloat(n) : Number.NaN));
    if (values.some(Number.isNaN)) return null;
    if (kind === "rgb") {
        if (nums.some((n) => n.endsWith("%")) || values.some((v) => v > 255)) return null;
        return { r: values[0], g: values[1], b: values[2] };
    }
    const [h, s, l] = values;
    if (h > 360 || s > 100 || l > 100) return null;
    return hslToRgb({ h, s, l });
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
    const [R, G, B] = [r / 255, g / 255, b / 255];
    const max = Math.max(R, G, B);
    const min = Math.min(R, G, B);
    const d = max - min;
    const l = (max + min) / 2;
    if (d === 0) return { h: 0, s: 0, l: l * 100 };
    const s = d / (1 - Math.abs(2 * l - 1));
    let h: number;
    if (max === R) h = ((G - B) / d + 6) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    return { h: h * 60, s: s * 100, l: l * 100 };
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
    const S = s / 100;
    const L = l / 100;
    const f = (n: number) => {
        const k = (n + h / 30) % 12;
        return L - S * Math.min(L, 1 - L) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return { r: f(0) * 255, g: f(8) * 255, b: f(4) * 255 };
}

export function toHex(c: Rgb): string {
    return `#${[c.r, c.g, c.b].map((v) => byte(v).toString(16).padStart(2, "0")).join("")}`;
}

export function toRgbString(c: Rgb): string {
    return `rgb(${byte(c.r)}, ${byte(c.g)}, ${byte(c.b)})`;
}

export function toHslString(c: Rgb): string {
    const { h, s, l } = rgbToHsl(c);
    return `hsl(${Math.round(h) % 360}, ${Math.round(s)}%, ${Math.round(l)}%)`;
}

/** WCAG 2.x relative luminance, 0 (black) to 1 (white). */
export function luminance(c: Rgb): number {
    const lin = (v: number) => {
        const s = byte(v) / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG contrast ratio, 1 to 21. */
export function contrast(a: Rgb, b: Rgb): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

export interface Grades {
    aaNormal: boolean;
    aaLarge: boolean;
    aaaNormal: boolean;
    aaaLarge: boolean;
}

export function grade(ratio: number): Grades {
    return { aaNormal: ratio >= 4.5, aaLarge: ratio >= 3, aaaNormal: ratio >= 7, aaaLarge: ratio >= 4.5 };
}

/** Rows for the converter: label and value. */
export function conversionRows(c: Rgb): [string, string][] {
    return [
        ["hex", toHex(c)],
        ["rgb", toRgbString(c)],
        ["hsl", toHslString(c)],
    ];
}

/** Rows for the contrast result: label and value. */
export function contrastRows(fg: Rgb, bg: Rgb): [string, string][] {
    const ratio = contrast(fg, bg);
    const g = grade(ratio);
    const mark = (ok: boolean) => (ok ? "pass" : "fail");
    return [
        // floor, not round: 4.499 must not read as the 4.50 that passes
        ["ratio", `${(Math.floor(ratio * 100) / 100).toFixed(2)} : 1`],
        ["AA text", mark(g.aaNormal)],
        ["AA large text", mark(g.aaLarge)],
        ["AAA text", mark(g.aaaNormal)],
        ["AAA large text", mark(g.aaaLarge)],
    ];
}
