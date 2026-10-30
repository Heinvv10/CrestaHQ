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
 * Whether `url` is this tenant's uploaded logo, as Remove decides it (the
 * DELETE routes and the cards' Remove button): an absolute URL whose path is
 * exactly this tenant's serving path, on any origin, so a logo uploaded
 * before NEXT_PUBLIC_APP_URL changed still clears instead of being left
 * pointing at a deleted blob. Another tenant's path, the other scope, or the
 * prefix in a query doesn't match.
 */
export function pointsAtUploadedLogo(
  url: string | null | undefined,
  scope: LogoScope,
  id: string,
): boolean {
  return !!url && URL.canParse(url) && new URL(url).pathname === uploadedLogoPath(scope, id);
}
