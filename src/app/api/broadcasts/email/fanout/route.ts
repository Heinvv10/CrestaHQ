import "server-only";

import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { FieldPath, FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  publishCallback,
  qstashIsConfigured,
  verifyQStashSignature,
} from "@/lib/automations/qstash";
import { resolveAudiencePage } from "@/lib/broadcasts/audience";
import {
  BROADCAST_FANOUT_RETRIES,
  maybeMarkBroadcastCompleted,
} from "@/lib/broadcasts/completion";
import type { BroadcastDoc, BroadcastSendDoc } from "@/types";

export const dynamic = "force-dynamic";

/**
 * Broadcast fan-out, one audience page per call. A QStash callback published
 * by /api/broadcasts/email/send (first page) and by itself (every next page)
 * — the same self-rescheduling drain as /api/import/ghl/step. Public path;
 * security is the Upstash-Signature check.
 *
 * Per page: write the send rows + bump the parent totals in one batch, then
 * publish one staggered /step message per recipient. A publish that fails
 * marks its row failed, so the broadcast still completes. Redelivery is safe:
 * rows are created (never overwritten), rows already queued are re-published
 * under their original dedup id, settled rows are left alone. Returning 500
 * makes QStash retry the same page; after the final retry the broadcast
 * completes with what was queued, errorMessage saying where it stopped.
 */

/**
 * Send throttle: 5/sec — well under Resend's free-tier 10 req/sec API cap,
 * leaving headroom for concurrent one-off sends. `slot` counts recipients
 * published so far across pages, so the stagger continues page to page.
 */
const SEND_RATE_PER_SECOND = 5;
/** Publishes in flight at once within a page. */
const PUBLISH_CONCURRENCY = 20;
/** Upper bound on this page's already-written rows read on redelivery. */
const EXISTING_SCAN_LIMIT = 1000;

interface FanoutBody {
  broadcastId?: string;
  cursor?: string | null;
  slot?: number;
  territoryIds?: string[] | null;
}

export async function POST(request: Request) {
  if (!qstashIsConfigured()) {
    return NextResponse.json({ error: "QStash is not configured." }, { status: 503 });
  }
  const signature = request.headers.get("upstash-signature");
  if (!signature) {
    return NextResponse.json({ error: "Missing Upstash-Signature header" }, { status: 401 });
  }
  const rawBody = await request.text();
  if (!(await verifyQStashSignature(signature, rawBody))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }
  let payload: FanoutBody;
  try {
    payload = JSON.parse(rawBody) as FanoutBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { broadcastId } = payload;
  const cursor = typeof payload.cursor === "string" ? payload.cursor : null;
  const slot = typeof payload.slot === "number" ? payload.slot : 0;
  const territoryIds = Array.isArray(payload.territoryIds) ? payload.territoryIds : null;
  if (typeof broadcastId !== "string") {
    return NextResponse.json({ error: "broadcastId is required" }, { status: 400 });
  }

  const db = getAdminDb();
  const broadcastRef = db.collection("broadcasts").doc(broadcastId);
  try {
    return await runPage(db, broadcastRef, { cursor, slot, territoryIds });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "fan-out failed";
    console.error("[broadcasts/fanout] page failed", broadcastId, err);
    const retried = Number(request.headers.get("upstash-retried") ?? "0");
    if (retried < BROADCAST_FANOUT_RETRIES) {
      return NextResponse.json({ error: msg }, { status: 500 });
    }
    // Last delivery: nothing will run the rest of the audience. Don't fail
    // the broadcast — steps already published keep sending, and it must stay
    // cancellable. Record why it stopped short and let it complete with
    // what was queued.
    await db.runTransaction(async (tx) => {
      const current = (await tx.get(broadcastRef)).data() as BroadcastDoc | undefined;
      if (current?.status !== "queued" && current?.status !== "sending") return;
      tx.update(broadcastRef, {
        fanoutDone: true,
        errorMessage: `Audience fan-out stopped after ${current.totals?.audienceSize ?? 0} contacts: ${msg}`,
      });
    });
    await maybeMarkBroadcastCompleted(broadcastRef);
    return NextResponse.json({ ok: false, fanoutStopped: true });
  }
}

async function runPage(
  db: FirebaseFirestore.Firestore,
  broadcastRef: FirebaseFirestore.DocumentReference,
  { cursor, slot, territoryIds }: {
    cursor: string | null;
    slot: number;
    territoryIds: string[] | null;
  },
): Promise<Response> {
  const broadcastId = broadcastRef.id;
  const snap = await broadcastRef.get();
  if (!snap.exists) return NextResponse.json({ ok: true, ignored: "missing" });
  const broadcast = snap.data() as BroadcastDoc;
  // Cancelled (or otherwise finished): stop paging — nothing new is queued.
  if (broadcast.status === "cancelled" || broadcast.status === "failed" || broadcast.status === "completed") {
    return NextResponse.json({ ok: true, ignored: broadcast.status });
  }

  const page = await resolveAudiencePage(
    broadcast.subAccountId,
    broadcast.audienceFilter,
    territoryIds,
    cursor,
  );

  const sendsCol = broadcastRef.collection("sends");
  const pageContacts = [
    ...page.recipients.map((contact) => ({ contact, reason: null })),
    ...page.skipped,
  ];
  // Rows a previous delivery of this page already wrote: rows are keyed by
  // contact id and pages are id-ordered, so they are exactly the rows in
  // (cursor, page end] — including any whose contact has since opted out,
  // been deleted or been re-filtered out of the page.
  let existingQuery = sendsCol.orderBy(FieldPath.documentId());
  if (cursor) existingQuery = existingQuery.startAfter(cursor);
  const existing = (await existingQuery.limit(EXISTING_SCAN_LIMIT).get()).docs.filter(
    (d) => page.nextCursor === null || d.id <= page.nextCursor,
  );
  const existingStatus = new Map(
    existing.map((d) => [d.id, (d.data() as BroadcastSendDoc).status]),
  );
  // Every still-queued row of this page is (re-)published. The row was the
  // audience when it was written; the step re-checks opt-out, email and the
  // contact's existence, so none is stranded queued here.
  const toPublish: string[] = [...existingStatus]
    .filter(([, status]) => status === "queued")
    .map(([id]) => id);

  // New rows + their totals in one atomic batch (≤ page size + 1 writes).
  const batch = db.batch();
  let newQueued = 0;
  let newSkipped = 0;
  for (const { contact, reason } of pageContacts) {
    if (existingStatus.has(contact.id)) continue;
    const row: Omit<BroadcastSendDoc, "id"> = {
      broadcastId,
      agencyId: broadcast.agencyId,
      subAccountId: broadcast.subAccountId,
      contactId: contact.id,
      toEmail: contact.email,
      toName: contact.name,
      status: reason ? "skipped" : "queued",
      skippedReason: reason,
      resendMessageId: null,
      error: null,
      attempts: 0,
      queuedAt: FieldValue.serverTimestamp() as unknown as null,
      sentAt: reason ? (FieldValue.serverTimestamp() as unknown as null) : null,
    };
    batch.create(sendsCol.doc(contact.id), { id: contact.id, ...row });
    if (reason) {
      newSkipped += 1;
    } else {
      newQueued += 1;
      toPublish.push(contact.id);
    }
  }
  if (newQueued + newSkipped > 0) {
    batch.update(broadcastRef, {
      "totals.audienceSize": FieldValue.increment(newQueued + newSkipped),
      "totals.queued": FieldValue.increment(newQueued),
      "totals.skipped": FieldValue.increment(newSkipped),
    });
    await batch.commit();
  }

  // One staggered /step message per queued recipient.
  const failedIds: string[] = [];
  for (let i = 0; i < toPublish.length; i += PUBLISH_CONCURRENCY) {
    const chunk = toPublish.slice(i, i + PUBLISH_CONCURRENCY);
    const results = await Promise.all(
      chunk.map((contactId, j) =>
        publishCallback({
          // Explicit, so the stale-claim timeline doesn't hang on QStash defaults.
          retries: BROADCAST_FANOUT_RETRIES,
          pathname: "/api/broadcasts/email/step",
          body: { broadcastId, contactId },
          delaySeconds: Math.ceil((slot + i + j) / SEND_RATE_PER_SECOND),
          // Per-row dedup key — a redelivered page re-publishes under the
          // same id, so QStash drops the duplicate.
          deduplicationId: `bcast_${broadcastId}_${contactId}`,
        }),
      ),
    );
    results.forEach((r, j) => {
      if (!r) failedIds.push(chunk[j]!);
    });
  }
  // Nothing will ever run these rows — settle them as failed so the
  // broadcast can still complete, and so the operator sees who missed out.
  // Conditional: on a redelivered page an earlier publish of the row may
  // already have reached a step.
  for (const id of failedIds) {
    const rowRef = sendsCol.doc(id);
    await db.runTransaction(async (tx) => {
      const row = (await tx.get(rowRef)).data() as BroadcastSendDoc | undefined;
      if (row?.status !== "queued" || row.claimedAt) return;
      tx.update(rowRef, {
        status: "failed",
        error: "Could not schedule this send (queue publish failed).",
        sentAt: FieldValue.serverTimestamp(),
      });
      tx.update(broadcastRef, {
        "totals.failed": FieldValue.increment(1),
        "totals.queued": FieldValue.increment(-1),
      });
    });
  }

  if (page.nextCursor) {
    const next = await publishCallback({
      retries: BROADCAST_FANOUT_RETRIES,
      pathname: "/api/broadcasts/email/fanout",
      body: {
        broadcastId,
        cursor: page.nextCursor,
        slot: slot + toPublish.length,
        territoryIds,
      },
      delaySeconds: 0,
      deduplicationId: `bcastfan_${broadcastId}_${createHash("sha256").update(page.nextCursor).digest("hex").slice(0, 32)}`,
    });
    if (!next) {
      // Retry this page; its rows are already written and re-publish safely.
      throw new Error("Failed to schedule the next fan-out page");
    }
    return NextResponse.json({ ok: true, queued: toPublish.length, next: page.nextCursor });
  }

  await broadcastRef.update({ fanoutDone: true });
  await maybeMarkBroadcastCompleted(broadcastRef);
  return NextResponse.json({ ok: true, queued: toPublish.length, done: true });
}
