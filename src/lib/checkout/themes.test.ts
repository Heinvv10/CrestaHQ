import { describe, expect, it } from "vitest";
import {
  CHECKOUT_THEMES,
  checkoutThemeCssVars,
  isCheckoutThemeId,
  isHexColor,
  resolveCheckoutTheme,
} from "@/lib/checkout/themes";
import { CHECKOUT_THEME_IDS } from "@/types/checkout-pages";

/**
 * Style presets for the public checkout and booking pages: which stored
 * values count as a preset, and what a page without one resolves to.
 */

const appearance = (over: object = {}) => ({
  theme: "light" as const,
  accent: "#7c3aed",
  hideChrome: false,
  hideTitle: false,
  ...over,
});

/** A no-preset page: the nearest preset, with the page's own accent carried over. */
const withAccent = (base: "clean" | "midnight", accent: string) => ({
  ...CHECKOUT_THEMES[base],
  accent,
  accentSoft: `${accent}0f`,
  buttonBg: accent,
});

/** Stored "colours" that must never reach a style attribute. */
const HOSTILE_COLOURS = [
  "red",
  "#7c3aed;background:url(https://evil.example/x)",
  "red;position:fixed;inset:0;background:url(https://evil.example/x)",
  "#7c3aed\n",
  " #7c3aed",
  "#7c3aed0f",
  "#12345",
  "url(javascript:alert(1))",
  '"><script>alert(1)</script>',
  "",
  42,
  ["#aabbcc"],
  { toString: () => "#aabbcc" },
  null,
  undefined,
];

describe("isCheckoutThemeId", () => {
  it("accepts exactly the listed ids, each of which has a theme", () => {
    for (const id of CHECKOUT_THEME_IDS) {
      expect(isCheckoutThemeId(id)).toBe(true);
      expect(CHECKOUT_THEMES[id].id).toBe(id);
    }
    expect(Object.keys(CHECKOUT_THEMES).sort()).toEqual([...CHECKOUT_THEME_IDS].sort());
  });

  it("rejects everything else, including names every object has", () => {
    for (const v of ["bogus", "Clean", " clean", "clean ", "", "constructor", "__proto__", "toString", null, undefined, 0, 42, {}, ["clean"]]) {
      expect(isCheckoutThemeId(v), JSON.stringify(v)).toBe(false);
    }
  });
});

describe("isHexColor", () => {
  it("accepts a 6-digit hex, and a 3-digit one only when asked", () => {
    for (const v of ["#7c3aed", "#7C3AED", "#000000"]) {
      expect(isHexColor(v)).toBe(true);
      expect(isHexColor(v, true)).toBe(true);
    }
    expect(isHexColor("#F50")).toBe(false);
    expect(isHexColor("#F50", true)).toBe(true);
  });

  it("rejects everything that is not exactly a hex colour string", () => {
    for (const v of HOSTILE_COLOURS) {
      expect(isHexColor(v), JSON.stringify(v)).toBe(false);
      expect(isHexColor(v, true), JSON.stringify(v)).toBe(false);
    }
  });
});

describe("resolveCheckoutTheme", () => {
  it("returns the preset's own tokens for a known id, whatever the appearance says", () => {
    for (const id of CHECKOUT_THEME_IDS) {
      expect(resolveCheckoutTheme({ themePreset: id, appearance: appearance({ theme: "dark", accent: "#ff0000" }) })).toBe(
        CHECKOUT_THEMES[id],
      );
    }
  });

  it("maps a page with no preset to Clean or Midnight, carrying its own accent", () => {
    for (const themePreset of [undefined, null]) {
      expect(resolveCheckoutTheme({ themePreset, appearance: appearance() })).toEqual(withAccent("clean", "#7c3aed"));
      expect(resolveCheckoutTheme({ themePreset, appearance: appearance({ theme: "dark" }) })).toEqual(withAccent("midnight", "#7c3aed"));
      expect(resolveCheckoutTheme({ themePreset, appearance: appearance({ accent: "#0EA5E9" }) })).toEqual(withAccent("clean", "#0EA5E9"));
    }
  });

  it("drops a stored accent that is not a 6-digit hex string, keeping the preset's own", () => {
    for (const accent of HOSTILE_COLOURS) {
      expect(resolveCheckoutTheme({ appearance: appearance({ accent }) as never }), JSON.stringify(accent)).toBe(CHECKOUT_THEMES.clean);
      expect(resolveCheckoutTheme({ appearance: appearance({ accent, theme: "dark" }) as never }), JSON.stringify(accent)).toBe(
        CHECKOUT_THEMES.midnight,
      );
    }
  });

  it("treats an unknown stored preset, or a page with no appearance, as no preset", () => {
    for (const themePreset of ["bogus", "constructor", "__proto__", "", 42, { id: "ocean" }, ["ocean"]]) {
      expect(resolveCheckoutTheme({ themePreset: themePreset as never, appearance: appearance() }), JSON.stringify(themePreset)).toEqual(
        withAccent("clean", "#7c3aed"),
      );
    }
    expect(resolveCheckoutTheme({ appearance: undefined as never })).toBe(CHECKOUT_THEMES.clean);
    expect(resolveCheckoutTheme({ appearance: null as never })).toBe(CHECKOUT_THEMES.clean);
  });
});

describe("checkoutThemeCssVars", () => {
  it("maps a preset onto the shadcn variables, using only the preset's own values", () => {
    for (const theme of Object.values(CHECKOUT_THEMES)) {
      const vars = checkoutThemeCssVars(theme);
      expect(Object.keys(vars).every((k) => /^--[a-z-]+$/.test(k))).toBe(true);
      expect(vars).toMatchObject({
        "--card": theme.cardBg,
        "--foreground": theme.text,
        "--primary": theme.buttonBg,
        "--primary-foreground": theme.buttonText,
        "--ring": theme.accent,
        "--muted": theme.isDark ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.05)",
      });
    }
  });
});
