import { describe, expect, it } from "vitest";
import { DEFAULT_BRAND_COLOR, contrastOnWhite, isUsableBrandColor, resolveBrandColor } from "./brand-color";

describe("contrastOnWhite", () => {
  it("known WCAG pairs", () => {
    // Black on white: the maximum possible ratio, 21:1.
    expect(contrastOnWhite("#000000")).toBeCloseTo(21, 0);
    // White on white: no contrast at all.
    expect(contrastOnWhite("#FFFFFF")).toBeCloseTo(1, 1);
    // A mid-saturation blue that comfortably clears AA.
    expect(contrastOnWhite("#2563EB")).toBeCloseTo(5.17, 1);
    // Pure yellow: nearly as bright as white, fails badly.
    expect(contrastOnWhite("#FFFF00")).toBeCloseTo(1.07, 1);
  });

  it("returns 0 for a malformed hex string", () => {
    expect(contrastOnWhite("blue")).toBe(0);
    expect(contrastOnWhite("#fff")).toBe(0);
    expect(contrastOnWhite("")).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(contrastOnWhite("#2563eb")).toBeCloseTo(contrastOnWhite("#2563EB"), 5);
  });
});

describe("isUsableBrandColor", () => {
  it("rejects a pale colour that fails 4.5:1", () => {
    expect(isUsableBrandColor("#FFFF00")).toBe(false);
    expect(isUsableBrandColor("#F0F0F0")).toBe(false);
  });

  it("accepts a dark colour that clears 4.5:1", () => {
    expect(isUsableBrandColor("#2563EB")).toBe(true);
    expect(isUsableBrandColor("#000000")).toBe(true);
  });

  it("rejects malformed input", () => {
    expect(isUsableBrandColor("not-a-color")).toBe(false);
    expect(isUsableBrandColor("#12345")).toBe(false);
  });
});

describe("resolveBrandColor", () => {
  it("returns the stored value, upper-cased, when usable", () => {
    expect(resolveBrandColor("#2563eb")).toBe("#2563EB");
  });

  it("falls back to the default for null, undefined, or an invalid value", () => {
    expect(resolveBrandColor(null)).toBe(DEFAULT_BRAND_COLOR);
    expect(resolveBrandColor(undefined)).toBe(DEFAULT_BRAND_COLOR);
    expect(resolveBrandColor("#FFFF00")).toBe(DEFAULT_BRAND_COLOR);
    expect(resolveBrandColor("not-a-color")).toBe(DEFAULT_BRAND_COLOR);
  });
});
