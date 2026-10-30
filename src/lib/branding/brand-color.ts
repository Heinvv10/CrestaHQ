/**
 * Agency `brandColor` (prospect report redesign, R2): the hex colour behind
 * the public report's header, accents and call-to-action. White text is
 * drawn over it everywhere it is used, so a colour that fails WCAG AA
 * (4.5:1) against white is unusable and rejected at save — never adjusted
 * silently (see the SOW's "Brand colour contrast" risk).
 *
 * Pure and client-safe: no server imports, so both the PATCH route and the
 * settings form's inline validation share this exact math.
 */

const HEX_RE = /^#[0-9a-f]{6}$/i;

/** Fallback used whenever a stored value is absent or invalid. */
export const DEFAULT_BRAND_COLOR = "#2563EB";

/** Minimum WCAG AA contrast ratio required for white text on the colour. */
export const MIN_CONTRAST = 4.5;

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Relative luminance (WCAG 2.x) of a `#RRGGBB` hex string. */
function relativeLuminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/**
 * Contrast ratio of white text (#FFFFFF, luminance 1) against `hex`. White
 * is always the lighter of the two colours, so the WCAG ratio simplifies to
 * `1.05 / (L + 0.05)`. Returns 0 for a malformed hex string.
 */
export function contrastOnWhite(hex: string): number {
  if (!HEX_RE.test(hex)) return 0;
  return 1.05 / (relativeLuminance(hex) + 0.05);
}

/**
 * True for a well-formed `#RRGGBB` value that clears the AA contrast bar.
 * No separate format check: `contrastOnWhite` already returns 0 for a
 * malformed hex, which always fails `MIN_CONTRAST`.
 */
export function isUsableBrandColor(hex: string): boolean {
  return contrastOnWhite(hex) >= MIN_CONTRAST;
}

/**
 * Read-time resolution: the stored value when it is still usable, else the
 * default. Guards against a value that was valid at save time under an
 * earlier version of this file, or written by a path that skipped the PATCH
 * route (a script, a fixture, a future migration).
 */
export function resolveBrandColor(value: string | null | undefined): string {
  return value && isUsableBrandColor(value) ? value.toUpperCase() : DEFAULT_BRAND_COLOR;
}
