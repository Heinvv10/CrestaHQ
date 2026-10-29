/**
 * Shared limits for uploaded logos. Stored as base64 in a Firestore doc
 * (no Firebase Storage setup needed), so the decoded cap stays well under the
 * 1 MB document limit.
 */

export const LOGO_MAX_BYTES = 400_000;
/** Longest edge after the browser resize. Big enough for retina headers. */
export const LOGO_MAX_EDGE = 512;
/** Source files above this are refused before the browser even decodes them. */
export const LOGO_SOURCE_MAX_BYTES = 5 * 1024 * 1024;

export type LogoMime = "image/png" | "image/webp";

/** Path prefix of the public serving route; also how we spot an uploaded logo. */
export const LOGO_ROUTE_PREFIX = "/api/brand/logo/";

export function isUploadedLogoUrl(url: string | null | undefined): boolean {
  return !!url && url.includes(LOGO_ROUTE_PREFIX);
}
