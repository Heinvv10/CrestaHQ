import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { INVALID_LINK } from "@/lib/snapshots/share";
import { downloadSharedSnapshot } from "@/lib/snapshots/share-redeem";

const fileName = (name: string) =>
  `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "snapshot"}.leadstack-snapshot.json`;

/**
 * GET — public download of a shared snapshot as a portable file. The token is
 * the only credential (see the middleware public-path note). Downloading
 * counts as a use, so a single-use link downloads once. Not cacheable, and no
 * CORS: it is fetched by a browser navigation from the share page, not by
 * another origin's script.
 *
 * Not rate limited: the token is 256 random bits, so guessing is not a
 * practical attack, and there is no shared per-IP limiter for public routes
 * to join (checkout, booking and the GBP feed each keep their own buckets).
 */
export async function GET(
  _request: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;
  const file = await downloadSharedSnapshot(getAdminDb(), { token });
  if (!file) {
    return NextResponse.json(
      { error: INVALID_LINK },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  return new NextResponse(JSON.stringify(file, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fileName(file.name)}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
