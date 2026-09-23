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
import { resolveVoiceAudiencePage } from "@/lib/comms/voice/audience";
import {
  FANOUT_RETRIES,
  maybeCompleteCampaign,
  settleQueuedRecipient,
} from "@/lib/comms/voice/campaign-rows";
import type { VoiceCampaignDoc, VoiceCampaignRecipientDoc } from "@/types";

export const dynamic = "force-dynamic";

/**
 * Voice campaign fan-out, one audience page per call. A QStash callback
 * published by /api/comms/voice/campaign/send (first page) and by itself
 * (every next page) — the same self-rescheduling drain as the broadcast
 * fanout. Public path; security is the Upstash-Signature check.
 *
 * Per page: create the recipient rows + bump the campaign totals in one
 * batch, then publish one paced /step message per recipient. A publish that
 * fails settles its row as failed, so the campaign still completes.
 * Redelivery is safe: rows are created (never overwritten), rows already
 * queued are re-published under their original dedup id. Returning 500
 * makes QStash retry the same page; the final retry fails the campaign.
 */

/** Publishes in flight at once within a page. */
const PUBLISH_CONCURRENCY = 20;
/** Upper bound on this page's already-written rows read on redelivery. */
const EXISTING_SCAN_LIMIT = 1000;

interface FanoutBody {
  campaignId?: string;
  cursor?: string | null;
  /** Recipients published so far — the pacing continues page to page. */
  slot?: number;
  /** Seconds between consecutive calls (60 / per-minute cap). */
  spacingSec?: number;
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
  const { campaignId } = payload;
  const cursor = typeof payload.cursor === "string" ? payload.cursor : null;
  const slot = typeof payload.slot === "number" ? payload.slot : 0;
  const spacingSec = typeof payload.spacingSec === "number" ? payload.spacingSec : 60;
  const territoryIds = Array.isArray(payload.territoryIds) ? payload.territoryIds : null;
  if (typeof campaignId !== "string") {
    return NextResponse.json({ error: "campaignId is required" }, { status: 400 });
  }

  const db = getAdminDb();
  const campaignRef = db.collection("voiceCampaigns").doc(campaignId);
  try {
    return await runPage(db, campaignRef, { cursor, slot, spacingSec, territoryIds });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "fan-out failed";
    console.error("[voice/campaign/fanout] page failed", campaignId, err);
    const retried = Number(request.headers.get("upstash-retried") ?? "0");
    if (retried < FANOUT_RETRIES) {
      return NextResponse.json({ error: msg }, { status: 500 });
    }
    // Last delivery: nothing will run this page again. Fail the campaign
    // visibly rather than leave it queued / calling with fanoutDone false.
    await campaignRef.update({
      status: "failed",
      errorMessage: `Audience fan-out stopped after repeated failures: ${msg}`,
      completedAt: FieldValue.serverTimestamp(),
    });
    return NextResponse.json({ ok: false, campaignFailed: true });
  }
}

async function runPage(
  db: FirebaseFirestore.Firestore,
  campaignRef: FirebaseFirestore.DocumentReference,
  { cursor, slot, spacingSec, territoryIds }: {
    cursor: string | null;
    slot: number;
    spacingSec: number;
    territoryIds: string[] | null;
  },
): Promise<Response> {
  const campaignId = campaignRef.id;
  const snap = await campaignRef.get();
  if (!snap.exists) return NextResponse.json({ ok: true, ignored: "missing" });
  const campaign = snap.data() as VoiceCampaignDoc;
  // Cancelled (or otherwise finished): stop paging — nothing new is queued.
  if (campaign.status === "cancelled" || campaign.status === "failed" || campaign.status === "completed") {
    return NextResponse.json({ ok: true, ignored: campaign.status });
  }

  const page = await resolveVoiceAudiencePage(
    campaign.subAccountId,
    campaign.audienceFilter,
    territoryIds,
    campaign.suppression ?? null,
    cursor,
  );

  const recCol = campaignRef.collection("recipients");
  const pageContacts = [
    ...page.recipients.map((contact) => ({ contact, reason: null })),
    ...page.skipped,
  ];
  // Rows a previous delivery of this page already wrote: rows are keyed by
  // contact id and pages are id-ordered, so they are exactly the rows in
  // (cursor, page end] — including any whose contact has since been deleted
  // or re-filtered out of the page.
  let existingQuery = recCol.orderBy(FieldPath.documentId());
  if (cursor) existingQuery = existingQuery.startAfter(cursor);
  const existing = (await existingQuery.limit(EXISTING_SCAN_LIMIT).get()).docs.filter(
    (d) => page.nextCursor === null || d.id <= page.nextCursor,
  );
  const existingStatus = new Map(
    existing.map((d) => [d.id, (d.data() as VoiceCampaignRecipientDoc).status]),
  );
  // Every still-queued row of this page is (re-)published; the step
  // re-checks the contact, so one that has since opted out or vanished is
  // settled there rather than stranded here.
  const toPublish: string[] = [...existingStatus]
    .filter(([, status]) => status === "queued")
    .map(([id]) => id);

  // New rows + their totals in one atomic batch (≤ page size + 1 writes).
  const batch = db.batch();
  let newQueued = 0;
  let newSkipped = 0;
  for (const { contact, reason } of pageContacts) {
    if (existingStatus.has(contact.id)) continue;
    const row: Omit<VoiceCampaignRecipientDoc, "id"> = {
      campaignId,
      agencyId: campaign.agencyId,
      subAccountId: campaign.subAccountId,
      contactId: contact.id,
      toPhone: contact.phone,
      toName: contact.name,
      status: reason ? "skipped" : "queued",
      skippedReason: reason,
      callId: null,
      callControlUrl: null,
      outcome: null,
      callDurationSec: null,
      endedReason: null,
      callSummary: null,
      taskId: null,
      error: null,
      attempts: 0,
      queuedAt: FieldValue.serverTimestamp() as unknown as null,
      settledAt: reason ? (FieldValue.serverTimestamp() as unknown as null) : null,
    };
    batch.create(recCol.doc(contact.id), { id: contact.id, ...row });
    if (reason) {
      newSkipped += 1;
    } else {
      newQueued += 1;
      toPublish.push(contact.id);
    }
  }
  if (newQueued + newSkipped > 0) {
    batch.update(campaignRef, {
      "totals.audienceSize": FieldValue.increment(newQueued + newSkipped),
      "totals.queued": FieldValue.increment(newQueued),
      "totals.skipped": FieldValue.increment(newSkipped),
    });
    await batch.commit();
  }

  const failedIds: string[] = [];
  for (let i = 0; i < toPublish.length; i += PUBLISH_CONCURRENCY) {
    const chunk = toPublish.slice(i, i + PUBLISH_CONCURRENCY);
    const results = await Promise.all(
      chunk.map((contactId, j) =>
        publishCallback({
          pathname: "/api/comms/voice/campaign/step",
          body: { campaignId, contactId },
          delaySeconds: Math.ceil((slot + i + j) * spacingSec),
          deduplicationId: `vcamp_${campaignId}_${contactId}`,
        }),
      ),
    );
    results.forEach((r, j) => {
      if (!r) failedIds.push(chunk[j]!);
    });
  }
  // Nothing will ever run these rows — settle them so the campaign can
  // still complete. Conditional: a redelivered page's earlier publish of the
  // row may already have reached a step.
  for (const id of failedIds) {
    await settleQueuedRecipient(recCol.doc(id), campaignRef, {
      status: "failed",
      error: "Could not schedule this call (queue publish failed).",
    });
  }

  if (page.nextCursor) {
    const next = await publishCallback({
      retries: FANOUT_RETRIES,
      pathname: "/api/comms/voice/campaign/fanout",
      body: {
        campaignId,
        cursor: page.nextCursor,
        slot: slot + toPublish.length,
        spacingSec,
        territoryIds,
      },
      delaySeconds: 0,
      deduplicationId: `vcampfan_${campaignId}_${createHash("sha256").update(page.nextCursor).digest("hex").slice(0, 32)}`,
    });
    if (!next) {
      // Retry this page; its rows are already written and re-publish safely.
      throw new Error("Failed to schedule the next fan-out page");
    }
    return NextResponse.json({ ok: true, queued: toPublish.length, next: page.nextCursor });
  }

  await campaignRef.update({ fanoutDone: true });
  await maybeCompleteCampaign(campaignRef);
  return NextResponse.json({ ok: true, queued: toPublish.length, done: true });
}
