import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  publishCallback,
  qstashIsConfigured,
  verifyQStashSignature,
} from "@/lib/automations/qstash";
import { resolveVoiceAudiencePage } from "@/lib/comms/voice/audience";
import {
  maybeCompleteCampaign,
  settleQueuedRecipient,
} from "@/lib/comms/voice/campaign-rows";
import type { VoiceCampaignDoc, VoiceCampaignRecipientDoc } from "@/types";
import type { Contact } from "@/types/contacts";

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
 * makes QStash retry the same page.
 */

/** Publishes in flight at once within a page. */
const PUBLISH_CONCURRENCY = 20;

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
  const existing = pageContacts.length
    ? await db.getAll(...pageContacts.map(({ contact }) => recCol.doc(contact.id)))
    : [];
  const existingStatus = new Map(
    existing
      .filter((s) => s.exists)
      .map((s) => [s.id, (s.data() as VoiceCampaignRecipientDoc).status]),
  );

  // New rows + their totals in one atomic batch (≤ page size + 1 writes).
  const batch = db.batch();
  let newQueued = 0;
  let newSkipped = 0;
  const toPublish: Contact[] = [];
  for (const { contact, reason } of pageContacts) {
    const status = existingStatus.get(contact.id);
    if (status !== undefined) {
      if (status === "queued" && !reason) toPublish.push(contact);
      continue;
    }
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
      toPublish.push(contact);
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
      chunk.map((contact, j) =>
        publishCallback({
          pathname: "/api/comms/voice/campaign/step",
          body: { campaignId, contactId: contact.id },
          delaySeconds: Math.ceil((slot + i + j) * spacingSec),
          deduplicationId: `vcamp_${campaignId}_${contact.id}`,
        }),
      ),
    );
    results.forEach((r, j) => {
      if (!r) failedIds.push(chunk[j]!.id);
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
      pathname: "/api/comms/voice/campaign/fanout",
      body: {
        campaignId,
        cursor: page.nextCursor,
        slot: slot + toPublish.length,
        spacingSec,
        territoryIds,
      },
      delaySeconds: 0,
      deduplicationId: `vcampfan_${campaignId}_${page.nextCursor.replace(/[^a-zA-Z0-9]/g, "_")}`,
    });
    if (!next) {
      // Retry this page; its rows are already written and re-publish safely.
      return NextResponse.json({ error: "Failed to schedule the next page" }, { status: 500 });
    }
    return NextResponse.json({ ok: true, queued: toPublish.length, next: page.nextCursor });
  }

  await campaignRef.update({ fanoutDone: true });
  await maybeCompleteCampaign(campaignRef);
  return NextResponse.json({ ok: true, queued: toPublish.length, done: true });
}
