import "server-only";

import { NextResponse } from "next/server";
import { qstashIsConfigured, verifyQStashSignature } from "@/lib/automations/qstash";
import { isDocId } from "@/lib/server/doc-id";
import { runPageSpeed } from "@/lib/server/website-pagespeed";
import {
  requireWebsiteEnabledSub,
  WebsiteServiceError,
  websitePageSpeedPath,
} from "@/lib/server/websites-service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST — run Google PageSpeed Insights (mobile) on a live site and store the
 * scores on the website doc. Delivered by QStash ~2 minutes after a build
 * publishes (`settleWebsiteBuild` schedules it).
 *
 * Public path (middleware PUBLIC_PATH_PATTERNS): the QStash signature, bound
 * to THIS route's URL for this site, is the only credential, and the body's
 * ids must match the path. No signing keys configured = 503; a missing or
 * bad signature = 401. Upstream also accepted a sub-account admin's session
 * here for a "Re-check" button its card no longer has; that branch is not
 * ported, so the route has exactly one way in.
 *
 * Gated on `websiteEnabledByAgency` like the builder's other new work: a
 * check that lands after the gate went off is acknowledged (200, so QStash
 * does not retry) and does nothing.
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string; siteId: string }> },
) {
  const { id: subAccountId, siteId } = await ctx.params;
  // Document ids, never paths — answered before anything touches Firestore.
  if (!isDocId(subAccountId) || !isDocId(siteId)) {
    return NextResponse.json({ error: "Website not found." }, { status: 404 });
  }

  if (!qstashIsConfigured()) {
    return NextResponse.json({ error: "QStash is not configured." }, { status: 503 });
  }
  const signature = request.headers.get("upstash-signature");
  const rawBody = await request.text();
  if (!signature) return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  const url = appUrl ? `${appUrl}${websitePageSpeedPath(subAccountId, siteId)}` : null;
  if (!url || !(await verifyQStashSignature(signature, rawBody, url))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body: { subAccountId?: unknown; siteId?: unknown };
  try {
    body = JSON.parse(rawBody) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (body.subAccountId !== subAccountId || body.siteId !== siteId) {
    return NextResponse.json({ error: "Body ids must match the path." }, { status: 400 });
  }

  try {
    await requireWebsiteEnabledSub(subAccountId);
  } catch (err) {
    if (err instanceof WebsiteServiceError && (err.status === 403 || err.status === 404)) {
      return NextResponse.json({ ok: true, ignored: err.status === 403 ? "gate-off" : "sub-account-not-found" });
    }
    throw err;
  }

  const result = await runPageSpeed(subAccountId, siteId);
  if (!result) return NextResponse.json({ ok: true, ignored: "site-not-live" });
  return NextResponse.json({ ok: true, pagespeed: { ...result, at: null } });
}
