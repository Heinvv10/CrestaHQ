import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  ICON_MAX_BYTES,
  ICON_VARIANTS,
  type IconVariantKey,
} from "@/lib/pwa/icon-variants";

/**
 * Server side of the custom app-icon feature. Icons live as base64 PNG in
 * `agencies/{agencyId}/pwaIcons/{variant}` (server-only rules; the public
 * /api/pwa/icon route serves the bytes). `agency.pwaIconsUpdatedAt` is the
 * existence flag + cache-busting version the manifest reads.
 *
 * One agency per deployment in v1, so "which agency's icons?" resolves the
 * same way the landing brand does: appConfig/main → firstAgencyId.
 */

export async function getFirstAgencyId(): Promise<string | null> {
  try {
    const snap = await getAdminDb().doc("appConfig/main").get();
    return snap.exists
      ? ((snap.data()?.firstAgencyId as string | undefined) ?? null)
      : null;
  } catch {
    return null;
  }
}

/**
 * Millis of the last icon upload, or null when no custom icons exist (or
 * anything fails — callers fall back to the static files).
 */
export async function getPwaIconVersion(): Promise<number | null> {
  try {
    const agencyId = await getFirstAgencyId();
    if (!agencyId) return null;
    const snap = await getAdminDb().doc(`agencies/${agencyId}`).get();
    const ts = snap.data()?.pwaIconsUpdatedAt as
      | { toMillis?: () => number }
      | null
      | undefined;
    return ts && typeof ts.toMillis === "function" ? ts.toMillis() : null;
  } catch {
    return null;
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Validate one uploaded variant: decodes, is a real PNG, has the exact
 * expected square dimensions (read from the IHDR chunk — no image library
 * needed), and fits the Firestore-doc byte budget. Returns the decoded
 * buffer or a human-readable problem string.
 */
export function validateIconPng(
  variantKey: IconVariantKey,
  base64: unknown,
): Buffer | string {
  const variant = ICON_VARIANTS.find((v) => v.key === variantKey);
  if (!variant) return "Unknown icon variant";
  if (typeof base64 !== "string" || base64.length === 0) {
    return "Missing icon data";
  }
  // +33% base64 overhead over the decoded cap, with slack for padding.
  if (base64.length > ICON_MAX_BYTES * 1.4) {
    return "Icon is too large — use a simpler image";
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(base64, "base64");
  } catch {
    return "Icon data isn't valid base64";
  }
  if (buf.length > ICON_MAX_BYTES) {
    return "Icon is too large — use a simpler image";
  }
  if (buf.length < 24 || !PNG_SIGNATURE.every((b, i) => buf[i] === b)) {
    return "Icon must be a PNG";
  }
  // IHDR is always the first chunk: width at 16-19, height at 20-23.
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width !== variant.size || height !== variant.size) {
    return `Icon must be ${variant.size}×${variant.size}`;
  }
  return buf;
}
