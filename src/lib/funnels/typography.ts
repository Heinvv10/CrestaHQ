import type { FunnelFontPair, FunnelStyle } from "@/types/funnels";

/**
 * Typography presets for funnel pages.
 *
 * THE biggest single visual lever. A high-converting sales page runs a very
 * large, tight, often condensed heading against modest body text — FHL 2026
 * sits at roughly 70px h1 / 38px h2 / 17px body in Barlow Condensed. The old
 * default here was system-ui at 40px, which is why well-written pages still
 * read as documents.
 *
 * Fonts load from Google Fonts with `display=swap`, so text paints immediately
 * in the fallback and reflows when the webfont arrives — never a blank page if
 * the CDN is slow. "system" loads nothing at all.
 */

export interface FontPreset {
  key: FunnelFontPair;
  label: string;
  hint: string;
  /** Google Fonts href, or null for system fonts. */
  href: string | null;
  headingStack: string;
  bodyStack: string;
  /** Condensed faces carry tighter tracking well. */
  headingTracking: string;
  headingWeight: number;
}

const SYSTEM_STACK =
  "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export const FONT_PRESETS: FontPreset[] = [
  // Body fonts are deliberately NOT Inter/Roboto/system — that combination is
  // the default look of every AI-generated page on the internet, and the whole
  // point of a preset is that the page reads as designed. Each pairing keeps a
  // matched family or a complementary grotesque instead.
  {
    key: "condensed",
    label: "Condensed",
    hint: "Big, tight, punchy. The classic sales-page look.",
    href: "https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700;800&family=Barlow:wght@400;500;600&display=swap",
    headingStack: `'Barlow Condensed', ${SYSTEM_STACK}`,
    bodyStack: `'Barlow', ${SYSTEM_STACK}`,
    headingTracking: "-0.01em",
    headingWeight: 800,
  },
  {
    key: "geometric",
    label: "Geometric",
    hint: "Characterful and modern. Good for software and services.",
    href: "https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700;12..96,800&family=Manrope:wght@400;500;600&display=swap",
    headingStack: `'Bricolage Grotesque', ${SYSTEM_STACK}`,
    bodyStack: `'Manrope', ${SYSTEM_STACK}`,
    headingTracking: "-0.02em",
    headingWeight: 700,
  },
  {
    key: "editorial",
    label: "Editorial",
    hint: "Serif headlines. Reads as considered rather than salesy.",
    href: "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Source+Sans+3:wght@400;500;600&display=swap",
    headingStack: `'Fraunces', Georgia, serif`,
    bodyStack: `'Source Sans 3', ${SYSTEM_STACK}`,
    headingTracking: "-0.015em",
    headingWeight: 700,
  },
  {
    key: "classic",
    label: "Classic",
    hint: "Straight-talking sans. Understated, high trust.",
    href: "https://fonts.googleapis.com/css2?family=Work+Sans:wght@600;700;800&display=swap",
    headingStack: `'Work Sans', ${SYSTEM_STACK}`,
    bodyStack: `'Work Sans', ${SYSTEM_STACK}`,
    headingTracking: "-0.02em",
    headingWeight: 800,
  },
  {
    key: "system",
    label: "System",
    hint: "No webfont. Fastest, plainest.",
    href: null,
    headingStack: SYSTEM_STACK,
    bodyStack: SYSTEM_STACK,
    headingTracking: "-0.025em",
    headingWeight: 800,
  },
];

export function fontPreset(key: FunnelFontPair | undefined): FontPreset {
  return FONT_PRESETS.find((f) => f.key === key) ?? FONT_PRESETS[0];
}

/** Resolved sizes for one page, after the scale multiplier. */
export interface TypeScale {
  h1: number;
  h2: number;
  h3: number;
  lede: number;
  body: number;
  transform: "uppercase" | "none";
  headingStack: string;
  bodyStack: string;
  tracking: string;
  weight: number;
  width: number;
}

export function typeScale(style: FunnelStyle | undefined): TypeScale {
  const s = style ?? {
    fontPair: "condensed" as FunnelFontPair,
    headingScale: 1.15,
    uppercaseHeadings: false,
    contentWidth: 780,
  };
  const preset = fontPreset(s.fontPair);
  // Clamped so a bad value can't produce unreadable or comical type.
  const k = Math.min(Math.max(s.headingScale ?? 1, 0.7), 1.8);
  return {
    h1: Math.round(46 * k),
    h2: Math.round(30 * k),
    h3: Math.round(19 * k),
    lede: 18,
    body: 16.5,
    transform: s.uppercaseHeadings ? "uppercase" : "none",
    headingStack: preset.headingStack,
    bodyStack: preset.bodyStack,
    tracking: preset.headingTracking,
    weight: preset.headingWeight,
    width: Math.min(Math.max(s.contentWidth ?? 780, 560), 1100),
  };
}
