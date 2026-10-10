import { describe, expect, it } from "vitest";
import {
  CHECKOUT_THEMES,
  checkoutThemeCssVars,
  isCheckoutThemeId,
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

/** What /co hard-coded before presets existed, light and dark. */
const LEGACY_LIGHT = {
  isDark: false,
  pageBg: "#fafafa",
  cardBg: "#fff",
  cardBorder: "none",
  cardShadow: "0 1px 3px rgba(0,0,0,0.08)",
  cardRadius: 16,
  text: "#18181b",
  muted: "#52525b",
  faint: "#71717a",
  accent: "#7c3aed",
  accentSoft: "#7c3aed0f",
  buttonBg: "#7c3aed",
  buttonText: "#fff",
  buttonRadius: 10,
  inputBg: "#fff",
  inputText: "#18181b",
  inputBorder: "1px solid rgba(0,0,0,0.15)",
  inputBorderColor: "rgba(0,0,0,0.15)",
  inputRadius: 8,
  divider: "rgba(0,0,0,0.1)",
  bumpBorder: "2px dashed rgba(0,0,0,0.18)",
  bumpBg: "rgba(0,0,0,0.015)",
  headingTransform: "none",
  headingWeight: 700,
  headingSpacing: "normal",
  legacy: { formMuted: "#52525b", bumpRadius: 10, buttonWeight: 600, noticeText: "#92400e" },
};

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

describe("resolveCheckoutTheme", () => {
  it("returns the preset's own tokens for a known id, whatever the appearance says", () => {
    for (const id of CHECKOUT_THEME_IDS) {
      expect(resolveCheckoutTheme({ themePreset: id, appearance: appearance({ theme: "dark", accent: "#ff0000" }) })).toBe(
        CHECKOUT_THEMES[id],
      );
    }
    expect(Object.values(CHECKOUT_THEMES).every((t) => t.legacy === undefined)).toBe(true);
  });

  it("gives a page with no preset the exact values the page used before presets", () => {
    for (const themePreset of [undefined, null]) {
      const light = resolveCheckoutTheme({ themePreset, appearance: appearance() });
      expect(light).toEqual({ id: "clean", label: "Clean", blurb: CHECKOUT_THEMES.clean.blurb, ...LEGACY_LIGHT });
      const dark = resolveCheckoutTheme({ themePreset, appearance: appearance({ theme: "dark" }) });
      expect(dark).toEqual({
        id: "midnight",
        label: "Midnight",
        blurb: CHECKOUT_THEMES.midnight.blurb,
        ...LEGACY_LIGHT,
        isDark: true,
        pageBg: "#18181b",
        cardBg: "#27272a",
        text: "#fafafa",
        muted: "#a1a1aa",
      });
    }
  });

  it("carries a page's own accent onto the button and the ticked bump", () => {
    const t = resolveCheckoutTheme({ appearance: appearance({ accent: "#0EA5E9" }) });
    expect(t).toMatchObject({ accent: "#0EA5E9", buttonBg: "#0EA5E9", accentSoft: "#0EA5E90f" });
  });

  it("falls back to the default accent for anything that is not a 6-digit hex", () => {
    const hostile = [
      "red",
      "#fff",
      "#7c3aed;background:url(https://evil.example/x)",
      "#7c3aed\n",
      "url(javascript:alert(1))",
      '"><script>alert(1)</script>',
      "",
      42,
      ["#aabbcc"],
      null,
    ];
    for (const accent of hostile) {
      const t = resolveCheckoutTheme({ appearance: appearance({ accent }) as never });
      expect(t, JSON.stringify(accent)).toMatchObject({ accent: "#7c3aed", buttonBg: "#7c3aed", accentSoft: "#7c3aed0f" });
    }
  });

  it("treats an unknown stored preset, or a page with no appearance, as no preset", () => {
    const expected = { id: "clean", label: "Clean", blurb: CHECKOUT_THEMES.clean.blurb, ...LEGACY_LIGHT };
    for (const themePreset of ["bogus", "constructor", "__proto__", "", 42, {}]) {
      expect(resolveCheckoutTheme({ themePreset: themePreset as never, appearance: appearance() })).toEqual(expected);
    }
    expect(resolveCheckoutTheme({ appearance: undefined as never })).toEqual(expected);
    expect(resolveCheckoutTheme({ appearance: null as never })).toEqual(expected);
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
