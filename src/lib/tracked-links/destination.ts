/**
 * Destination-URL validation for tracked links.
 *
 * The `/l/{token}` route 302s to whatever this returns, so an unvalidated
 * value here is an open redirect with our domain's reputation behind it.
 * Only absolute http(s) URLs pass — `javascript:`, `data:`, and relative
 * paths are rejected. Applied at every write AND again on read, so a doc
 * written before this check existed still can't produce a bad redirect.
 */

const MAX_URL_LENGTH = 2048;

export function normalizeDestinationUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.toString();
}
