import "server-only";

import { revalidateTag } from "next/cache";
import { BUYER_MAP_DATA_TAG } from "@/lib/landing/buyer-map-cache";

/**
 * Bust the cached buyer-map aggregate so the landing map reflects a brand-new
 * buyer on the next request. Called from the Stripe founders webhook + the
 * manual-purchase route — the only places a `purchases` doc with geo is born.
 * Best-effort: a revalidation failure must never break the purchase flow (the
 * long safety-net revalidate in buyer-map-cache covers a miss).
 */
export function revalidateBuyerMap(): void {
  try {
    revalidateTag(BUYER_MAP_DATA_TAG);
  } catch (err) {
    console.error("[buyer-map] revalidate failed", err);
  }
}
