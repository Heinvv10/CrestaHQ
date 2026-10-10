import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/**
 * WCAG 2 contrast maths for the style-preset tests, plus a lookup of
 * Tailwind's own palette (read from the installed package, so a Tailwind
 * upgrade that moves a colour is measured rather than assumed).
 */

export type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a 6-digit hex colour: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)) as Rgb;
}

/** `rgba(r,g,b,a)` → the colour and its alpha. */
export function parseRgba(value: string): { rgb: Rgb; alpha: number } {
  const m = /^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/.exec(value);
  if (!m) throw new Error(`not an rgba() colour: ${value}`);
  return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], alpha: Number(m[4]) };
}

/** `fg` at `alpha` painted over an opaque `bg`. */
export function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return fg.map((c, i) => alpha * c + (1 - alpha) * bg[i]) as Rgb;
}

function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1 to 21. Normal-size text needs 4.5 for AA. */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function oklchToRgb(l: number, c: number, hDeg: number): Rgb {
  const h = (hDeg * Math.PI) / 180;
  const [a, b] = [c * Math.cos(h), c * Math.sin(h)];
  const [l3, m3, s3] = [
    l + 0.3963377774 * a + 0.2158037573 * b,
    l - 0.1055613458 * a - 0.0638541728 * b,
    l - 0.0894841775 * a - 1.291485548 * b,
  ].map((v) => v ** 3);
  const linear = [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
  return linear.map((v) => {
    const x = Math.min(1, Math.max(0, v));
    return 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
  }) as Rgb;
}

let themeCss: string | null = null;

/** A Tailwind palette colour by name, e.g. `emerald-700`. */
export function tailwindColor(name: string): Rgb {
  themeCss ??= readFileSync(createRequire(import.meta.url).resolve("tailwindcss/theme.css"), "utf8");
  const m = new RegExp(`--color-${name}:\\s*oklch\\(([\\d.]+)%\\s+([\\d.]+)\\s+([\\d.]+)\\)`).exec(themeCss);
  if (!m) throw new Error(`Tailwind has no colour named ${name}`);
  return oklchToRgb(Number(m[1]) / 100, Number(m[2]), Number(m[3]));
}
