import { isCheckoutThemeId, isHexColor } from "@/lib/checkout/themes";
import type { CheckoutThemeId } from "@/types/checkout-pages";

/**
 * A stored booking page's style fields, as they may leave the server.
 *
 * The public pages (/b, the embed, /e) hand the doc to a client component,
 * and Next inlines every prop it is given into the HTML for hydration,
 * rendered or not. A check inside the component therefore keeps a bad value
 * out of the markup but not out of the response. So the loaders pass these
 * fields through here first: an accent that is not a plain hex (#RGB or
 * #RRGGBB, what the validator stores) and a preset id this build does not
 * know are dropped before anything is sent.
 */
export function publicBookingStyle(
  page: { accentColor?: unknown; themePreset?: unknown } | null | undefined,
): { accentColor: string | null; themePreset: CheckoutThemeId | null } {
  const accent = page?.accentColor;
  const preset = page?.themePreset;
  return {
    accentColor: isHexColor(accent, true) ? accent : null,
    themePreset: isCheckoutThemeId(preset) ? preset : null,
  };
}
