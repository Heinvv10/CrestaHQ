import { NextResponse } from "next/server";
import { logoDocRef, type LogoScope } from "@/lib/brand/logo-server";
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

export async function GET(
  request: Request,
  ctx: { params: Promise<{ scope: string; id: string }> },
) {
  const { scope, id } = await ctx.params;
  if ((scope !== "agency" && scope !== "sa") || !isDocId(id) || !ID_RE.test(id)) {
    return notFound();
  }

  try {
    const snap = await logoDocRef(scope as LogoScope, id).get();
    const data = snap.data();
    const b64 = data?.data as string | undefined;
    const mime = data?.mime as string | undefined;
    if (b64 && (mime === "image/png" || mime === "image/webp")) {
      const requested = new URL(request.url).searchParams.get("v");
      const current = requested !== null && requested === String(data?.version);
      return new NextResponse(Buffer.from(b64, "base64"), {
        headers: {
          "Content-Type": mime,
          // s-maxage lets the CDN absorb repeat hits instead of Firestore.
          "Cache-Control": current
            ? "public, max-age=31536000, s-maxage=31536000, immutable"
            : "public, max-age=300",
          "Content-Disposition": "inline",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
  } catch (err) {
    // Fall through to 404; logo requests never 500.
    console.warn("[brand/logo] read failed:", err instanceof Error ? err.message : String(err));
  }
  return notFound();
}
