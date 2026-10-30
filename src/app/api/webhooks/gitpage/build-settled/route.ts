import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { readBodyCapped } from "@/lib/api/body-limit";
import { getAdminDb } from "@/lib/firebase/admin";
import { settledPayloadToPollResult } from "@/lib/gitpage/client";
import { isDocId } from "@/lib/server/doc-id";
import { settleWebsiteBuild } from "@/lib/server/websites-service";
import type { WebsiteDoc } from "@/types/website";

export const dynamic = "force-dynamic";

/**
 * A callback is a status record plus the hand-off artefacts (a ≤6,000
 * character knowledge-base text, a persona prompt): a few KB. 64 KB is
 * generous, and it bounds what an unauthenticated caller can make this
 * route buffer and hash before the signature has been checked.
 */
const MAX_CALLBACK_BYTES = 64 * 1024;

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
 * arrives first settles the doc; the other no-ops. Always 200 on anything
 * but a bad signature or an oversized body so gitpage never retry-storms.
 *
 * This route only decides what is obviously not for it (a site already
 * live, a repeat failure report). Whether a callback may settle the site is
 * decided inside `settleWebsiteBuild`'s transaction, on the doc as it is at
 * that moment — including a site the poll cap marked `failed` that gitpage
 * has now published.
 *
 * No `websiteEnabledByAgency` check, on purpose: a build accepted while the
 * gate was on still settles after it goes off. Why: settleWebsiteBuild.
 */
export async function POST(request: Request) {
  const apiKey = process.env.GITPAGE_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "gitpage is not configured." }, { status: 503 });
  }

  // Bounded BEFORE the HMAC: Content-Length first, then the bytes as read.
  const rawBody = await readBodyCapped(request, MAX_CALLBACK_BYTES);
  if (rawBody === null) {
    return NextResponse.json({ error: "Request body too large" }, { status: 413 });
  }
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
  // A doc id, never a path: the value goes into a collection path below.
  const subAccountId = isDocId(body.subAccountId) ? body.subAccountId : null;
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

  const result = settledPayloadToPollResult(body);
  if (!result.isTerminal) {
    return NextResponse.json({ ok: true, ignored: "not-terminal" });
  }
  // In flight: settle. `failed`: only a Published report can change it (the
  // poll cap or a transient 4xx gave up before gitpage finished). Anything
  // else — a live site, a draft — is already settled as far as this job goes.
  const inFlight = site.status === "queued" || site.status === "building";
  const lateSuccess = site.status === "failed" && result.status === "Published";
  if (!inFlight && !lateSuccess) {
    return NextResponse.json({ ok: true, ignored: "already-settled" });
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
