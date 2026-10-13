import {
  CHECKOUT_THEME_IDS,
  type CheckoutPage,
  type CheckoutThemeId,
} from "@/types/checkout-pages";
import { isHexColor } from "@/lib/hex-color";

/**
 * Checkout page preset themes.
 *
 * Client-safe (no server-only imports) — consumed by the public page, the
 * public CheckoutForm, and the dashboard editor's preset picker. Every visual
 * decision on the public page reads from one of these token sets so a preset
 * is the ONLY styling axis; there are no per-token overrides in v1.
 *
 * "clean" and "midnight" intentionally reproduce the pre-theme light/dark
 * looks, so `resolveCheckoutTheme` can map legacy docs onto them without any
 * visual change.
 */

export interface CheckoutTheme {
  id: CheckoutThemeId;
  label: string;
  /** One-liner under the label in the editor's picker. */
  blurb: string;
  /** Dark-surface theme — drives derived overlay tints and Tailwind `dark:`
   *  variants on pages styled via CSS variables (see checkoutThemeCssVars). */
  isDark: boolean;

  pageBg: string;
  cardBg: string;
  /** CSS border shorthand for the card; "none" for shadow-only cards. */
  cardBorder: string;
  cardShadow: string;
  cardRadius: number;

  text: string;
  muted: string;
  /** Footnote / fine-print text. */
  faint: string;

  accent: string;
  /** Translucent accent wash behind a ticked bump. */
  accentSoft: string;

  buttonBg: string;
  buttonText: string;
  buttonRadius: number;

  inputBg: string;
  inputText: string;
  inputBorder: string;
  /** The color half of `inputBorder`, for CSS-variable consumers. */
  inputBorderColor: string;
  inputRadius: number;

  divider: string;
  /** Un-ticked bump box border (dashed reads as "optional"). */
  bumpBorder: string;
  bumpBg: string;

  headingTransform: "none" | "uppercase";
  headingWeight: number;
  headingSpacing: string;
}

export const CHECKOUT_THEMES: Record<CheckoutThemeId, CheckoutTheme> = {
  clean: {
    id: "clean",
    label: "Clean",
    blurb: "Bright and minimal with a violet accent.",
    isDark: false,
    pageBg: "#fafafa",
    cardBg: "#ffffff",
    cardBorder: "none",
    cardShadow: "0 1px 3px rgba(0,0,0,0.08)",
    cardRadius: 16,
    text: "#18181b",
    muted: "#52525b",
    faint: "#71717a",
    accent: "#7c3aed",
    accentSoft: "rgba(124,58,237,0.06)",
    buttonBg: "#7c3aed",
    buttonText: "#ffffff",
    buttonRadius: 10,
    inputBg: "#ffffff",
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
  },
  midnight: {
    id: "midnight",
    label: "Midnight",
    blurb: "Dark card on a charcoal page, violet accent.",
    isDark: true,
    pageBg: "#18181b",
    cardBg: "#27272a",
    cardBorder: "none",
    cardShadow: "0 1px 3px rgba(0,0,0,0.35)",
    cardRadius: 16,
    text: "#fafafa",
    muted: "#a1a1aa",
    faint: "#8b8b93",
    accent: "#a78bfa",
    accentSoft: "rgba(167,139,250,0.1)",
    buttonBg: "#7c3aed",
    buttonText: "#ffffff",
    buttonRadius: 10,
    inputBg: "#18181b",
    inputText: "#fafafa",
    inputBorder: "1px solid rgba(255,255,255,0.16)",
    inputBorderColor: "rgba(255,255,255,0.16)",
    inputRadius: 8,
    divider: "rgba(255,255,255,0.12)",
    bumpBorder: "2px dashed rgba(255,255,255,0.22)",
    bumpBg: "rgba(255,255,255,0.03)",
    headingTransform: "none",
    headingWeight: 700,
    headingSpacing: "normal",
  },
  "noir-lime": {
    id: "noir-lime",
    label: "Noir Lime",
    blurb: "Near-black with an electric lime accent and bold uppercase type.",
    isDark: true,
    pageBg: "#050505",
    cardBg: "#0f0f10",
    cardBorder: "1px solid #222226",
    cardShadow: "0 0 0 1px rgba(204,255,0,0.04), 0 8px 30px rgba(0,0,0,0.6)",
    cardRadius: 4,
    text: "#f5f5f4",
    muted: "#9a9a93",
    faint: "#6f6f68",
    accent: "#ccff00",
    accentSoft: "rgba(204,255,0,0.08)",
    buttonBg: "#ccff00",
    buttonText: "#0a0a0a",
    buttonRadius: 2,
    inputBg: "#161617",
    inputText: "#f5f5f4",
    inputBorder: "1px solid #2c2c30",
    inputBorderColor: "#2c2c30",
    inputRadius: 2,
    divider: "rgba(255,255,255,0.12)",
    bumpBorder: "2px dashed rgba(204,255,0,0.35)",
    bumpBg: "rgba(255,255,255,0.02)",
    headingTransform: "uppercase",
    headingWeight: 800,
    headingSpacing: "0.04em",
  },
  sunset: {
    id: "sunset",
    label: "Sunset",
    blurb: "Warm cream page with a burnt-orange accent.",
    isDark: false,
    pageBg: "#fdf6ec",
    cardBg: "#fffdf8",
    cardBorder: "1px solid rgba(194,120,3,0.15)",
    cardShadow: "0 1px 3px rgba(120,53,15,0.08)",
    cardRadius: 18,
    text: "#292524",
    muted: "#78716c",
    faint: "#a8a29e",
    accent: "#ea580c",
    accentSoft: "rgba(234,88,12,0.07)",
    // HARDENING (ours, not upstream): upstream's #ea580c is 3.56:1 under white text; this is the nearest shade at 4.5:1.
    buttonBg: "#cd4d0b",
    buttonText: "#ffffff",
    buttonRadius: 12,
    inputBg: "#ffffff",
    inputText: "#292524",
    inputBorder: "1px solid rgba(120,53,15,0.2)",
    inputBorderColor: "rgba(120,53,15,0.2)",
    inputRadius: 10,
    divider: "rgba(120,53,15,0.15)",
    bumpBorder: "2px dashed rgba(234,88,12,0.35)",
    bumpBg: "rgba(234,88,12,0.02)",
    headingTransform: "none",
    headingWeight: 700,
    headingSpacing: "normal",
  },
  ocean: {
    id: "ocean",
    label: "Ocean",
    blurb: "Cool light blue-gray with a deep sky accent.",
    isDark: false,
    pageBg: "#f2f7fa",
    cardBg: "#ffffff",
    cardBorder: "1px solid rgba(3,105,161,0.12)",
    cardShadow: "0 1px 3px rgba(12,74,110,0.08)",
    cardRadius: 14,
    text: "#0f172a",
    muted: "#475569",
    faint: "#64748b",
    accent: "#0284c7",
    accentSoft: "rgba(2,132,199,0.06)",
    // HARDENING (ours, not upstream): upstream's #0284c7 is 4.10:1 under white text; this is the nearest shade at 4.5:1.
    buttonBg: "#027dbc",
    buttonText: "#ffffff",
    buttonRadius: 10,
    inputBg: "#ffffff",
    inputText: "#0f172a",
    inputBorder: "1px solid rgba(15,23,42,0.18)",
    inputBorderColor: "rgba(15,23,42,0.18)",
    inputRadius: 8,
    divider: "rgba(15,23,42,0.12)",
    bumpBorder: "2px dashed rgba(2,132,199,0.35)",
    bumpBg: "rgba(2,132,199,0.02)",
    headingTransform: "none",
    headingWeight: 700,
    headingSpacing: "normal",
  },
};

export const DEFAULT_CHECKOUT_THEME_ID: CheckoutThemeId = "clean";

/**
 * Map a preset onto the shadcn CSS variables so Tailwind-token surfaces
 * (the public booking page) can adopt it without a restyle: set these inline
 * on the page's root element and every `bg-card` / `text-muted-foreground` /
 * `border-input` etc. underneath resolves to the preset. Inline style wins
 * over both `:root` and `.dark`, so the visitor's OS theme can't fight it.
 *
 * The muted surface is derived from `isDark` rather than stored per preset —
 * it's an overlay tint, not a brand color.
 */
export function checkoutThemeCssVars(
  theme: CheckoutTheme,
): Record<string, string> {
  const mutedSurface = theme.isDark
    ? "rgba(255,255,255,0.07)"
    : "rgba(0,0,0,0.05)";
  return {
    "--background": theme.inputBg,
    "--foreground": theme.text,
    "--card": theme.cardBg,
    "--card-foreground": theme.text,
    "--popover": theme.cardBg,
    "--popover-foreground": theme.text,
    "--muted": mutedSurface,
    "--muted-foreground": theme.muted,
    "--border": theme.divider,
    "--input": theme.inputBorderColor,
    "--ring": theme.accent,
    "--primary": theme.buttonBg,
    "--primary-foreground": theme.buttonText,
  };
}

export function isCheckoutThemeId(v: unknown): v is CheckoutThemeId {
  return (
    typeof v === "string" &&
    (CHECKOUT_THEME_IDS as readonly string[]).includes(v)
  );
}

// HARDENING (ours, not upstream): the one test a stored custom colour must
// pass before it may reach a style attribute, re-exported for this file's
// existing importers.
export { isHexColor };

/**
 * Resolve the theme for a page, including legacy docs saved before presets
 * existed: those map to clean/midnight from `appearance.theme`, and a legacy
 * custom accent carries over so nobody's page changes color on deploy.
 */
export function resolveCheckoutTheme(
  page: Pick<CheckoutPage, "appearance"> & {
    themePreset?: CheckoutThemeId | null;
  },
): CheckoutTheme {
  if (page.themePreset && isCheckoutThemeId(page.themePreset)) {
    return CHECKOUT_THEMES[page.themePreset];
  }
  const base =
    page.appearance?.theme === "dark"
      ? CHECKOUT_THEMES.midnight
      : CHECKOUT_THEMES.clean;
  const accent = page.appearance?.accent;
  // HARDENING (ours): string-typed 6-digit hex only (upstream: any truthy value the regex coerces).
  if (isHexColor(accent)) {
    return {
      ...base,
      accent,
      accentSoft: `${accent}0f`,
      buttonBg: accent,
    };
  }
  return base;
}
