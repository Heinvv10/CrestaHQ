import "server-only";

import { NextResponse } from "next/server";
import { publishCallback, verifyQStashSignature } from "@/lib/automations/qstash";
import { isDocId } from "@/lib/server/doc-id";
import { requeueTimer, settleMissed } from "@/lib/prospecting/mystery-shop/store";
import { TIMER_REQUEUE_MS } from "@/lib/prospecting/mystery-shop/model";
import { TIMER_PATH } from "@/lib/prospecting/mystery-shop/context";

/**
 * The mystery shop's 24 h timer — one QStash message per sent shop, published
 * by `POST /api/sub-accounts/[id]/prospecting/mystery-shop` with `{ shopId }`,
 * 24 h + 30 min after the send (the grace lets the 15-minute IMAP sync bring
 * in a reply from the last minutes first).
 *
 * Public path — the QStash signature, bound to THIS route's URL, is the
 * authentication. Idempotent on shopId: a `sent` shop with no response
 * becomes `missed` in a transaction; a responded, missed, failed or unknown
 * shop is a 200 no-op, so a retry or duplicate delivery changes nothing. If
 * this never arrives, the contact's GET settles the shop instead.
 *
 * An email shop is not called missed while the inbox has not been read past
 * its window (the mailbox's last good sync is older, or it is failing): the
 * timer re-queues itself an hour later, at most MAX_TIMER_REQUEUES times
 * (counted on the shop); after that the GET sweep settles it once the sync
 * catches up.
 */

export const dynamic = "force-dynamic";

const PATH = TIMER_PATH;

export async function POST(request: Request) {
  const signature = request.headers.get("upstash-signature");
  const rawBody = await request.text();
  if (!signature) return NextResponse.json({ error: "Missing signature" }, { status: 401 });
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!appUrl || !(await verifyQStashSignature(signature, rawBody, `${appUrl}${PATH}`))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let shopId: unknown;
  try {
    shopId = (JSON.parse(rawBody) as { shopId?: unknown }).shopId;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!isDocId(shopId)) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const status = await settleMissed(shopId);
  if (status !== "awaiting_sync") return NextResponse.json({ ok: true, status });
  const requeue = await requeueTimer(shopId);
  if (requeue !== null) {
    const queued = await publishCallback({
      pathname: PATH,
      body: { shopId },
      delaySeconds: TIMER_REQUEUE_MS / 1000,
      deduplicationId: `mystery_shop_${shopId}_requeue_${requeue}_${Date.now()}`,
    });
    // Ask QStash to deliver this again rather than lose the wait.
    if (!queued) return NextResponse.json({ error: "requeue_failed" }, { status: 503 });
  }
  return NextResponse.json({ ok: true, status, requeue });
}
