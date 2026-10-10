import { describe, expect, it } from "vitest";
import { accentOnWhite, textOnAccent } from "@/components/web-chat/contrast";

const DARK = "#0f172a";
const WHITE = "#ffffff";

describe("textOnAccent", () => {
  it.each(["#facc15", "#ffff00", "#a3e635", "#fde68a", "#ffffff", "#fff"])("light accent %s gets dark text", (c) => {
    expect(textOnAccent(c)).toBe(DARK);
  });

  it.each(["#0f172a", "#1e3a8a", "#000080", "#000", "#2563eb", "#7c3aed", "#dc2626"])("dark/saturated accent %s gets white text", (c) => {
    expect(textOnAccent(c)).toBe(WHITE);
  });

  it("accepts hex without # and with surrounding whitespace, case-insensitively", () => {
    expect(textOnAccent("FACC15")).toBe(DARK);
    expect(textOnAccent("  #FACC15 ")).toBe(DARK);
  });

  it.each(["", "#12", "#12345", "#1234567", "red", "rgb(250,204,21)", "#gggggg"])("invalid value %j falls back to white", (c) => {
    expect(textOnAccent(c)).toBe(WHITE);
  });

  it("flips at the WCAG crossover: a mid grey just either side of the threshold", () => {
    // Crossover luminance is ~0.179: #777777 (L~0.184) -> dark, #767676 (L~0.181)... pin both sides.
    expect(textOnAccent("#808080")).toBe(DARK);
    expect(textOnAccent("#707070")).toBe(WHITE);
  });
});

describe("accentOnWhite", () => {
  it("darkens a light accent until it reads on white, leaves dark ones, passes invalid through", () => {
    expect(accentOnWhite("#facc15")).not.toBe("#facc15");
    expect(accentOnWhite("#1e3a8a")).toBe("#1e3a8a");
    expect(accentOnWhite("nope")).toBe("nope");
  });
});
