import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { getFirstAgencyId } from "@/lib/pwa/icons-server";
import {
  ICON_STATIC_FALLBACKS,
  type IconVariantKey,
} from "@/lib/pwa/icon-variants";

/**
 * Public icon endpoint the manifest + apple-touch link point at. Serves
 * the agency's uploaded icon when one exists, otherwise 302s to the
 * static LeadStack-mark fallback in /public — so consumers can always
 * reference this route without caring whether an upload happened.
 *
 * Public path (middleware): installers and the OS fetch icons without
 * credentials. The bytes are the deployment's own branding — nothing
 * sensitive to gate.
 */

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ variant: string }> },
) {
  const { variant } = await ctx.params;
  const fallback = ICON_STATIC_FALLBACKS[variant as IconVariantKey];
  if (!fallback) {
    return NextResponse.json({ error: "Unknown icon variant" }, { status: 404 });
  }

  try {
    const agencyId = await getFirstAgencyId();
    if (agencyId) {
      const snap = await getAdminDb()
        .doc(`agencies/${agencyId}/pwaIcons/${variant}`)
        .get();
      const png = snap.data()?.png as string | undefined;
      if (png) {
        return new NextResponse(Buffer.from(png, "base64"), {
          headers: {
            "Content-Type": "image/png",
            // The manifest busts with ?v=<upload millis>, so long cache is
            // safe; an hour bounds staleness for un-versioned consumers.
            "Cache-Control": "public, max-age=3600",
          },
        });
      }
    }
  } catch {
    // Fall through to the static mark — an icon request must never 500.
  }

  return NextResponse.redirect(new URL(fallback, request.url), 302);
}
