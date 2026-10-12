import { isBlockedHostname } from "@/lib/webhooks/validate-url";
import type { FunnelSection } from "@/types/funnels";

/** The longest URL the save route stores (sanitize.ts slices at 500). */
const MAX_LENGTH = 500;

/**
 * A stored funnel URL, if it is https on a public host, no longer than the
 * save route stores, and free of every character in `forbidden`. Else null.
 */
export function publicHttpsUrl(v: unknown, forbidden: RegExp): string | null {
  if (typeof v !== "string" || v.length === 0 || v.length > MAX_LENGTH) return null;
  if (forbidden.test(v)) return null;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return null;
  }
  return url.protocol === "https:" && !isBlockedHostname(url.hostname) ? v : null;
}

/**
 * A stored funnel image URL as it may be written into CSS `url(…)`: none of
 * the characters that could end the `url(…)` token or the declaration
 * around it (quotes, parentheses, backslash, whitespace, control
 * characters).
 */
export function funnelCssImageUrl(v: unknown): string | null {
  return publicHttpsUrl(v, /["'()\\\s\u0000-\u001f\u007f]/);
}

/**
 * The section with its background image dropped unless it passes
 * `funnelCssImageUrl`. Only hero and image bands in background mode write
 * the image into CSS; every other use is an `<img src>` and is left alone.
 */
export function withCheckedBackground(s: FunnelSection): FunnelSection {
  const isCssBackground =
    (s.type === "hero" || s.type === "image") && !!s.mediaAsBackground;
  if (!isCssBackground || !s.mediaUrl || funnelCssImageUrl(s.mediaUrl)) return s;
  return { ...s, mediaUrl: null };
}
