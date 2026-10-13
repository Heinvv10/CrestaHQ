import { describe, expect, it } from "vitest";
import { contrast, hexToRgb, over, parseRgba, tailwindColor } from "./contrast";

/** The contrast maths the preset tests lean on, against known values. */
describe("contrast helpers", () => {
  it("gives the WCAG reference ratios", () => {
    expect(contrast(hexToRgb("#000000"), hexToRgb("#ffffff"))).toBeCloseTo(21, 5);
    expect(contrast(hexToRgb("#ffffff"), hexToRgb("#ffffff"))).toBe(1);
    // #767676 on white is the textbook 4.5:1 boundary grey.
    expect(contrast(hexToRgb("#767676"), hexToRgb("#ffffff"))).toBeCloseTo(4.54, 2);
  });

  it("reads Tailwind's palette and converts it to sRGB", () => {
    const round = (name: string) => tailwindColor(name).map(Math.round);
    expect(round("emerald-700")).toEqual([0, 122, 85]);
    expect(round("rose-400")).toEqual([255, 99, 126]);
    expect(() => tailwindColor("nope-123")).toThrow("no colour named");
  });

  it("composites a tint over a background", () => {
    expect(over([255, 0, 0], 0.5, [255, 255, 255])).toEqual([255, 127.5, 127.5]);
    expect(parseRgba("rgba(245,158,11,0.08)")).toEqual({ rgb: [245, 158, 11], alpha: 0.08 });
  });
});
