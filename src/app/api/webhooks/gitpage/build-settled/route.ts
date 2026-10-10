import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { settledPayloadToPollResult } from "@/lib/gitpage/client";
import { settleWebsiteBuild } from "@/lib/server/websites-service";
import type { WebsiteDoc } from "@/types/website";

export const dynamic = "force-dynamic";

/**
 * gitpage → LeadStack `build.settled` callback (Website Build v2).
 *
 * gitpage POSTs here the moment a build finishes (success or failure) when
 * the submit request carried a `callbackUrl`. The body is HMAC-SHA256
 * signed with the agency's gitpage API key (`X-Gitpage-Signature:
 * sha256=<hex>`), so security is the signature, not the session cookie —
 * the path is in middleware's PUBLIC_PATH_PATTERNS.
 *
 * The QStash poll keeps running alongside this (belt and braces): whichever
 * arrives first settles the doc; the other sees a non-in-flight status and
 * no-ops. Always 200 on anything but a bad signature so gitpage never
 * retry-storms.
 */
export async function POST(request: Request) {
  const apiKey = process.env.GITPAGE_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "gitpage is not configured." }, { status: 503 });
  }

  const rawBody = await request.text();
  const header = request.headers.get("x-gitpage-signature") ?? "";
  const presented = header.startsWith("sha256=") ? header.slice(7) : header;
  const expected = createHmac("sha256", apiKey).update(rawBody).digest("hex");
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: true, ignored: "invalid-json" });
  }

  const formResponseId = typeof body.formResponseId === "string" ? body.formResponseId : null;
  const subAccountId = typeof body.subAccountId === "string" ? body.subAccountId : null;
  if (!formResponseId || !subAccountId) {
    return NextResponse.json({ ok: true, ignored: "missing-ids" });
  }

  const db = getAdminDb();
  const sites = await db
    .collection(`subAccounts/${subAccountId}/website`)
    .where("gitpageJobId", "==", formResponseId)
    .limit(1)
    .get();
  if (sites.empty) {
    return NextResponse.json({ ok: true, ignored: "site-not-found" });
  }
  const snap = sites.docs[0];
  const site = snap.data() as WebsiteDoc;
  if (site.status !== "queued" && site.status !== "building") {
    return NextResponse.json({ ok: true, ignored: "already-settled" });
  }

  const result = settledPayloadToPollResult(body);
  if (!result.isTerminal) {
    return NextResponse.json({ ok: true, ignored: "not-terminal" });
  }

  try {
    const settled = await settleWebsiteBuild({
      subAccountId,
      siteId: snap.id,
      site,
      result,
      attempts: site.pollAttempts ?? 0,
    });
    return NextResponse.json({ ok: true, settled });
  } catch (err) {
    console.error("[webhooks/gitpage/build-settled] settle threw", err);
    // 200 — the poll loop remains as the fallback settle path.
    return NextResponse.json({ ok: true, settled: "error" });
  }
}
