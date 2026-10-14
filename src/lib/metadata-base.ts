/**
 * Origin that relative OpenGraph / icon / manifest URLs resolve against.
 * Reads NEXT_PUBLIC_APP_URL. A missing, malformed (e.g. no protocol) or
 * non-http(s) value returns undefined so Next.js applies its own default
 * (the deployment URL on Vercel) rather than pinning URLs to localhost.
 */
export function resolveMetadataBase(appUrl: string | undefined): URL | undefined {
  try {
    const url = new URL(appUrl?.trim() ?? "");
    if (url.protocol === "http:" || url.protocol === "https:") return url;
  } catch {
    // fall through: let Next.js choose
  }
  return undefined;
}
