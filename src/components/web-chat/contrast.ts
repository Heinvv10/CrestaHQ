/**
 * Contrast helpers for the web-chat widget. The operator (or a website
 * build) picks any accent colour, and light accents (yellow, lime, pastel)
 * made the old hard-coded white text unreadable. WCAG 2.x relative luminance.
 *
 * Mirrored in plain JS inside public/widget.js (the launcher bubble) — keep
 * the two in sync.
 */

const DARK = "#0f172a";
const LIGHT = "#ffffff";

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

function luminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Text/icon colour to put ON the accent: dark slate or white, whichever
 *  contrasts more. Unparseable colours fall back to white (old behaviour). */
export function textOnAccent(accent: string): string {
  const rgb = parseHex(accent);
  if (!rgb) return LIGHT;
  return contrast(rgb, parseHex(DARK)!) > contrast(rgb, parseHex(LIGHT)!) ? DARK : LIGHT;
}

/** The accent, darkened just enough to read as text/border on a white
 *  background (≥ 3:1, the WCAG minimum for UI components and large text). */
export function accentOnWhite(accent: string): string {
  const rgb = parseHex(accent);
  if (!rgb) return accent;
  const white = parseHex(LIGHT)!;
  let cur = rgb;
  for (let i = 0; i < 20 && contrast(cur, white) < 3; i++) {
    cur = cur.map((v) => v * 0.88) as [number, number, number];
  }
  return toHex(cur);
}
