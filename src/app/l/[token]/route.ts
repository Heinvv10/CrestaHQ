import { NextResponse } from "next/server";

import { resolveTrackedLinkClick } from "@/lib/tracked-links/click";

export const dynamic = "force-dynamic";

/**
 * Public tracked-link redirect. `/l/{token}` for a per-contact click,
 * `/l/{linkId}` for an unattributed one. A missing link, a forged token or
 * a non-http(s) destination 404s — never 302, which would turn this into
 * an open redirect.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const { token } = await params;

  const destination = await resolveTrackedLinkClick({
    token,
    userAgent: request.headers.get("user-agent"),
    referer: request.headers.get("referer"),
  });
  if (!destination) {
    return new NextResponse("Not found", { status: 404 });
  }
  return NextResponse.redirect(destination, 302);
}
