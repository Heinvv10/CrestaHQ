import { NextResponse } from "next/server";
import { logoDocRef, type LogoScope } from "@/lib/brand/logo-server";
import { checkLogoRateLimit } from "@/lib/brand/logo-rate-limit";
import { cacheLogo, getCachedLogo, type CachedLogo } from "@/lib/brand/logo-cache";
import { isDocId } from "@/lib/server/doc-id";

/**
 * Public logo endpoint behind every uploaded `logoUrl`. Public because email
 * clients and visitors fetch it without credentials, and it's only branding.
 * The URL carries ?v=<upload millis>; only a request for the stored version
 * is cached as immutable, so a re-upload never leaves an old URL pinned to
 * new bytes (or a guessed one pinned to nothing).
 */

export const dynamic = "force-dynamic";

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });

function serve({ body, mime }: CachedLogo, current: boolean): NextResponse {
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
  if ((scope !== "agency" && scope !== "sa") || !isDocId(id) || !ID_RE.test(id)) {
    return notFound();
  }
  const requested = new URL(request.url).searchParams.get("v");
  // A hit is the version the URL names, read within the TTL: no read, no limit.
  const cached = getCachedLogo(scope, id, requested);
  if (cached) return serve(cached, true);

  // Before the read: the limit bounds what an anonymous caller costs Firestore.
  const retryAfter = checkLogoRateLimit(request);
  if (retryAfter > 0) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  try {
    const snap = await logoDocRef(scope as LogoScope, id).get();
    const data = snap.data();
    const b64 = data?.data as string | undefined;
    const mime = data?.mime as string | undefined;
    if (b64 && (mime === "image/png" || mime === "image/webp")) {
      const logo: CachedLogo = { body: Buffer.from(b64, "base64"), mime };
      const stored = typeof data?.version === "number" ? String(data.version) : null;
      if (stored !== null) cacheLogo(scope, id, stored, logo);
      return serve(logo, requested !== null && requested === stored);
    }
  } catch (err) {
    // Fall through to 404; logo requests never 500.
    console.warn("[brand/logo] read failed:", err instanceof Error ? err.message : String(err));
  }
  return notFound();
}
