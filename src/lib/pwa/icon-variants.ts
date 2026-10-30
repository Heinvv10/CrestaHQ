/**
 * The four home-screen icon variants a PWA install needs, shared by the
 * client-side canvas renderer (agency settings upload), the upload route's
 * validation, the public serving route, and the manifest.
 *
 * `pad` is the fraction of the canvas reserved as margin on each side —
 * the maskable variant keeps the mark inside the center ~70% because
 * Android crops the outer edges into a circle/squircle; Apple ignores
 * transparency so its variant also gets a filled background.
 *
 * (No "server-only" guard — the client renderer imports this too.)
 */

export const ICON_VARIANTS = [
  { key: "192", size: 192, pad: 0.08 },
  { key: "512", size: 512, pad: 0.08 },
  { key: "maskable", size: 512, pad: 0.15 },
  { key: "apple", size: 180, pad: 0.12 },
] as const;

export type IconVariantKey = (typeof ICON_VARIANTS)[number]["key"];

/** Background painted behind the uploaded mark (matches the manifest theme). */
export const ICON_BACKGROUND = "#18181b";

/**
 * Decoded-PNG byte cap per variant. Icons are stored as base64 in
 * Firestore (one doc per variant, no Firebase Storage dependency), so the
 * cap keeps every doc comfortably under the 1MB document limit even with
 * base64's +33% overhead. A 512px logo PNG is typically well under 200KB.
 */
export const ICON_MAX_BYTES = 500_000;

import { LANDING_VARIANT } from "@/config/landing";

/**
 * Static fallbacks served until an owner uploads an icon — variant-aware
 * so each deployment mode's defaults match its brand identity: buyers
 * ("custom") get the green "my CRM" set, the LeadStack demo gets the
 * chevron set. Both rendered by scripts/render-pwa-icons.mjs.
 */
const CUSTOM_FALLBACKS: Record<IconVariantKey, string> = {
  "192": "/icon-192.png",
  "512": "/icon-512.png",
  maskable: "/icon-maskable-512.png",
  apple: "/apple-touch-icon.png",
};

const LEADSTACK_FALLBACKS: Record<IconVariantKey, string> = {
  "192": "/leadstack-icon-192.png",
  "512": "/leadstack-icon-512.png",
  maskable: "/leadstack-icon-maskable-512.png",
  apple: "/leadstack-apple-touch-icon.png",
};

export const ICON_STATIC_FALLBACKS: Record<IconVariantKey, string> =
  LANDING_VARIANT === "custom" ? CUSTOM_FALLBACKS : LEADSTACK_FALLBACKS;
