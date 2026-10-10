const FALLBACK_ORIGIN = "http://localhost:3000";

/**
 * Origin that relative OpenGraph / icon / manifest URLs resolve against.
 * Reads NEXT_PUBLIC_APP_URL; a missing, malformed (e.g. no protocol) or
 * non-http(s) value falls back to localhost — what Next.js assumed before
 * metadataBase was set — so a bad env var can never break a build.
 */
export function resolveMetadataBase(appUrl: string | undefined): URL {
  try {
    const url = new URL(appUrl?.trim() ?? "");
    if (url.protocol === "http:" || url.protocol === "https:") return url;
  } catch {
    // fall through to the fallback
  }
  return new URL(FALLBACK_ORIGIN);
}
