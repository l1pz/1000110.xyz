import { describe, expect, it } from "vitest";
import {
    contrast,
    contrastRows,
    conversionRows,
    grade,
    hslToRgb,
    luminance,
    parseColor,
    rgbToHsl,
    toHex,
    toHslString,
    toRgbString,
} from "../src/features/tools/tools/color/color";

describe("parseColor", () => {
    it("reads hex", () => {
        expect(parseColor("#fabd2f")).toEqual({ r: 250, g: 189, b: 47 });
        expect(parseColor("FABD2F")).toEqual({ r: 250, g: 189, b: 47 });
        expect(parseColor("#fa0")).toEqual({ r: 255, g: 170, b: 0 });
        expect(parseColor("#fabd2")).toBeNull();
        expect(parseColor("#gggggg")).toBeNull();
    });

    it("reads rgb in several spellings", () => {
        expect(parseColor("rgb(1, 2, 3)")).toEqual({ r: 1, g: 2, b: 3 });
        expect(parseColor("rgb(1 2 3)")).toEqual({ r: 1, g: 2, b: 3 });
        expect(parseColor("1, 2, 3")).toEqual({ r: 1, g: 2, b: 3 });
        expect(parseColor("rgb(256, 0, 0)")).toBeNull();
        expect(parseColor("rgb(1, 2)")).toBeNull();
        expect(parseColor("rgb(10%, 2, 3)")).toBeNull();
    });

    it("reads hsl", () => {
        expect(toHex(parseColor("hsl(0, 100%, 50%)") as never)).toBe("#ff0000");
        expect(toHex(parseColor("hsl(120 100% 25%)") as never)).toBe("#008000");
        expect(parseColor("hsl(361, 0%, 0%)")).toBeNull();
        expect(parseColor("hsl(0, 101%, 0%)")).toBeNull();
        expect(parseColor("hsl(0, 100%)")).toBeNull();
    });

    it("rejects junk", () => {
        expect(parseColor("")).toBeNull();
        expect(parseColor("red")).toBeNull();
        expect(parseColor("rgb(a, b, c)")).toBeNull();
    });
});

describe("conversions", () => {
    it("round-trips rgb and hsl for the primaries and grays", () => {
        for (const hex of ["#ff0000", "#00ff00", "#0000ff", "#ffff00", "#000000", "#ffffff", "#808080", "#fabd2f"]) {
            const rgb = parseColor(hex) as never;
            expect(toHex(hslToRgb(rgbToHsl(rgb)))).toBe(hex);
        }
    });

    it("formats", () => {
        const c = { r: 250, g: 189, b: 47 };
        expect(toRgbString(c)).toBe("rgb(250, 189, 47)");
        expect(toHslString(c)).toBe("hsl(42, 95%, 58%)");
        expect(toHslString({ r: 0, g: 0, b: 0 })).toBe("hsl(0, 0%, 0%)");
        expect(conversionRows(c).map(([l]) => l)).toEqual(["hex", "rgb", "hsl"]);
    });

    it("keeps hue below 360 when rounding", () => {
        expect(toHslString({ r: 255, g: 0, b: 1 })).toBe("hsl(0, 100%, 50%)");
    });
});

describe("contrast", () => {
    const black = { r: 0, g: 0, b: 0 };
    const white = { r: 255, g: 255, b: 255 };

    it("has the WCAG extremes", () => {
        expect(luminance(white)).toBeCloseTo(1, 5);
        expect(luminance(black)).toBe(0);
        expect(contrast(black, white)).toBeCloseTo(21, 5);
        expect(contrast(white, white)).toBe(1);
        expect(contrast(white, black)).toBe(contrast(black, white));
    });

    it("matches a known pair", () => {
        // #777 on white is the classic 4.48:1 fail; #767676 is the lightest gray that passes AA
        expect(contrast(parseColor("#777") as never, white)).toBeCloseTo(4.48, 2);
        expect(contrast(parseColor("#767676") as never, white)).toBeCloseTo(4.54, 2);
    });

    it("grades at the thresholds", () => {
        expect(grade(4.5)).toEqual({ aaNormal: true, aaLarge: true, aaaNormal: false, aaaLarge: true });
        expect(grade(4.49)).toEqual({ aaNormal: false, aaLarge: true, aaaNormal: false, aaaLarge: false });
        expect(grade(7)).toMatchObject({ aaaNormal: true });
        expect(grade(2.9)).toMatchObject({ aaLarge: false });
    });

    it("never rounds a failing ratio up to a passing one", () => {
        const rows = contrastRows(parseColor("#777") as never, white);
        expect(rows[0][1]).toBe("4.47 : 1");
        expect(rows[1][1]).toBe("fail");
        expect(contrastRows(black, white)[0][1]).toBe("21.00 : 1");
    });
});
