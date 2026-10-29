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

/** Path prefix of the public serving route. */
export const LOGO_ROUTE_PREFIX = "/api/brand/logo/";

export type LogoScope = "agency" | "sa";

/**
 * The ids the public serving route will answer for. An upload under any
 * other id would store a logo whose URL can only ever 404, so the upload
 * routes refuse it too.
 */
export const LOGO_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** The serving path of one tenant's uploaded logo (no query). */
export function uploadedLogoPath(scope: LogoScope, id: string): string {
  return `${LOGO_ROUTE_PREFIX}${scope}/${encodeURIComponent(id)}`;
}

/**
 * Whether `url` is THIS tenant's uploaded logo: same origin as
 * NEXT_PUBLIC_APP_URL and exactly its serving path. Another tenant's logo,
 * another host, or the prefix anywhere else (`?r=/api/brand/logo/`) is a
 * pasted URL. False when the app URL is unset.
 */
export function isUploadedLogoUrl(
  url: string | null | undefined,
  scope: LogoScope,
  id: string,
): boolean {
  const base = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!url || !base || !URL.canParse(url) || !URL.canParse(base)) return false;
  const parsed = new URL(url);
  return parsed.origin === new URL(base).origin && parsed.pathname === uploadedLogoPath(scope, id);
}
