import "server-only";

import { NextResponse } from "next/server";
import { resolvePublicReport } from "@/lib/prospecting/public-report";

/**
 * GET — a shared prospect report as JSON. The share token in the path is the
 * only credential (see the middleware public-path note). Every refusal is the
 * same 404 — same status, body and headers — so a token cannot be probed.
 */

const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ shareId: string }> },
) {
  const { shareId } = await ctx.params;
  const report = await resolvePublicReport(shareId);
  if (!report) return NextResponse.json({ error: "Not found" }, { status: 404, headers: HEADERS });
  return NextResponse.json(report, { headers: HEADERS });
}
