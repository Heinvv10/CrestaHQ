import { NextResponse } from "next/server";
import { logoDocRef, type LogoScope } from "@/lib/brand/logo-server";
import { checkLogoRateLimit } from "@/lib/brand/logo-rate-limit";
import {
  cacheLogo,
  cacheMissingLogo,
  getCachedLogo,
  isKnownMissingLogo,
  isNewerVersion,
  logoCacheGeneration,
  type CachedLogo,
} from "@/lib/brand/logo-cache";
import { LOGO_ID_RE } from "@/lib/brand/logo-shared";
import { isDocId } from "@/lib/server/doc-id";

/**
 * Public logo endpoint behind every uploaded `logoUrl`. Public because email
 * clients and visitors fetch it without credentials, and it's only branding.
 * The URL carries ?v=<upload millis>. The response is immutable only when
 * ?v is the version of the bytes served, from the in-memory cache
 * (lib/brand/logo-cache.ts, the tenant's latest read) or a fresh read. No
 * ?v, or an older one, gets the latest bytes with a five-minute cache, so a
 * re-upload never pins an old URL to new bytes; a ?v newer than the cache
 * is a miss. Cache hits skip the Firestore read and the per-client limit;
 * only misses are limited (lib/brand/logo-rate-limit.ts).
 */

export const dynamic = "force-dynamic";

const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

function serve({ body, mime }: Pick<CachedLogo, "body" | "mime">, current: boolean): NextResponse {
  return new NextResponse(body, {
    headers: {
      "Content-Type": mime,
      // s-maxage lets the CDN absorb repeat hits instead of Firestore.
      "Cache-Control": current
        ? "public, max-age=31536000, s-maxage=31536000, immutable"
        : "public, max-age=300",
      "Content-Disposition": "inline",
      // Opened directly, the image document may run nothing and load nothing.
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ scope: string; id: string }> },
) {
  const { scope, id } = await ctx.params;
  if ((scope !== "agency" && scope !== "sa") || !isDocId(id) || !LOGO_ID_RE.test(id)) {
    return notFound();
  }
  const requested = new URL(request.url).searchParams.get("v");
  // A hit is the tenant's latest read within the TTL: no read, no limit.
  // Immutable only for its own version; a newer ?v is an upload not yet read.
  const cached = getCachedLogo(scope, id);
  if (cached && !isNewerVersion(requested, cached.version)) {
    return serve(cached, requested === String(cached.version));
  }
  // Read as absent in the last few seconds: 404 again with no read, no limit.
  if (!cached && isKnownMissingLogo(scope, id)) return notFound();

  // Before the read: the limit bounds what an anonymous caller costs Firestore.
  const retryAfter = checkLogoRateLimit(request);
  if (retryAfter > 0) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  try {
    const generation = logoCacheGeneration(scope, id);
    const snap = await logoDocRef(scope as LogoScope, id).get();
    const data = snap.data();
    if (!data) {
      cacheMissingLogo(scope, id, generation);
      return notFound();
    }
    const b64 = data?.data as string | undefined;
    const mime = data?.mime as string | undefined;
    if (b64 && (mime === "image/png" || mime === "image/webp")) {
      const body = Buffer.from(b64, "base64");
      const version = data?.version;
      if (typeof version === "number") cacheLogo(scope, id, { body, mime, version }, generation);
      return serve({ body, mime }, typeof version === "number" && requested === String(version));
    }
  } catch (err) {
    // Fall through to 404; logo requests never 500.
    console.warn("[brand/logo] read failed:", err instanceof Error ? err.message : String(err));
  }
  return notFound();
}
