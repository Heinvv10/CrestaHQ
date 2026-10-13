import { isHexColor } from "@/lib/checkout/themes";

export const DEFAULT_FUNNEL_ACCENT = "#7c3aed";

/**
 * A funnel's stored accent as it may be written into a style: the 6-digit
 * hex the save route stores (alpha digits are appended to it), or the
 * default. Anything else would land in the public page's CSS as written.
 */
export function funnelAccent(stored: unknown): string {
  return isHexColor(stored) ? stored : DEFAULT_FUNNEL_ACCENT;
}
