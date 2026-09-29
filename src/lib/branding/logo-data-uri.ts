import "server-only";

import { publicFetch } from "@/lib/webhooks/public-fetch";

/**
 * Fetch a tenant's logo ourselves, through the SSRF guard, and hand the
 * renderer a data URI — left to itself a renderer (@react-pdf, or `next/og`
 * for the report preview image) fetches any URL it is given, follows
 * redirects, and embeds the result in a file the requester downloads. Only
 * PNG/JPEG (by magic bytes — what both renderers can embed). Any failure
 * renders without a logo, as a broken URL did before. `timeoutMs` bounds the
 * whole fetch: the preview image must render in about 2 s (SOW risks).
 */
export async function loadLogoDataUri(url: string, timeoutMs = 5_000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await publicFetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    const type =
      bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
        ? "png"
        : bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
          ? "jpeg"
          : null;
    return type ? `data:image/${type};base64,${bytes.toString("base64")}` : null;
  } catch (err) {
    console.warn("[branding/logo] logo not embedded:", err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
