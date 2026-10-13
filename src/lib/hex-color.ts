/**
 * HARDENING (ours, not upstream): the one test a stored or third-party colour
 * must pass before it may reach a style attribute. `allowShort` also admits
 * #RGB. Pure and client-safe. Same signature as the copy on
 * feat/style-presets (src/lib/checkout/themes.ts), which should re-export
 * this one when it lands.
 */
export function isHexColor(v: unknown, allowShort = false): v is string {
  return (
    typeof v === "string" &&
    (/^#[0-9a-f]{6}$/i.test(v) || (allowShort && /^#[0-9a-f]{3}$/i.test(v)))
  );
}
