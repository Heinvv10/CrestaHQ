import "server-only";

import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  publishCallback,
  qstashIsConfigured,
  verifyQStashSignature,
} from "@/lib/automations/qstash";
import { getAgentProfile, getChannelConfig } from "@/lib/comms/ai/agent";
import { createOutboundCall, vapiIsConfigured } from "@/lib/comms/voice/vapi";
import {
  checkOutboundCompliance,
  type OutboundComplianceCode,
} from "@/lib/comms/voice/outbound-compliance";
import {
  claimDial,
  maybeCompleteCampaign,
  settleQueuedRecipient,
} from "@/lib/comms/voice/campaign-rows";
import type {
  VoiceCampaignDoc,
  VoiceCampaignRecipientDoc,
  VoiceCampaignSkipReason,
} from "@/types";
import type { Contact } from "@/types/contacts";

export const dynamic = "force-dynamic";

interface StepBody {
  campaignId?: string;
  contactId?: string;
}

/** Max step attempts (incl. window/rate deferrals) before we give up on a
 *  recipient. Window deferrals only happen 1-2× in practice; this is a
 *  defensive backstop against an infinite reschedule loop. */
const MAX_ATTEMPTS = 8;

/** Compliance codes that mean "try later" (reschedule, keep queued) vs.
 *  "give up" (skip with reason). */
const DEFERRABLE: ReadonlySet<OutboundComplianceCode> = new Set([
  "outside_window",
  "rate_limited",
]);

/**
 * Per-recipient bulk-call step. QStash callback published from
 * /api/comms/voice/campaign/send. Security is the Upstash-Signature header
 * (this route is in PUBLIC_PATH_PATTERNS, same as the broadcast step).
 *
 * Runs the native outbound compliance gate, then:
 *   - allowed              → place the Vapi call + mark the row "called"
 *   - deferrable (window /
 *     rate)                → republish this step with the gate's delay
 *   - any other block      → mark the row "skipped" with the reason
 *
 * Always returns 200 (except infra 503) so a single bad row never
 * retry-storms the campaign. Idempotent on the row status.
 */
export async function POST(request: Request) {
  if (!qstashIsConfigured()) {
    return NextResponse.json(
      { error: "QStash is not configured." },
      { status: 503 },
    );
  }
  if (!vapiIsConfigured()) {
    // Creds vanished post-fan-out — let QStash retry rather than burning
    // the row.
    return NextResponse.json(
      { error: "Voice isn't configured." },
      { status: 503 },
    );
  }

  const signature = request.headers.get("upstash-signature");
  if (!signature) {
    return NextResponse.json(
      { error: "Missing Upstash-Signature header" },
      { status: 401 },
    );
  }
  const rawBody = await request.text();
  if (!(await verifyQStashSignature(signature, rawBody))) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: StepBody;
  try {
    payload = JSON.parse(rawBody) as StepBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { campaignId, contactId } = payload;
  if (typeof campaignId !== "string" || typeof contactId !== "string") {
    return NextResponse.json(
      { error: "campaignId and contactId are required" },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const campaignRef = db.collection("voiceCampaigns").doc(campaignId);
  const recRef = campaignRef.collection("recipients").doc(contactId);

  const [campaignSnap, recSnap] = await Promise.all([
    campaignRef.get(),
    recRef.get(),
  ]);
  if (!campaignSnap.exists || !recSnap.exists) {
    return NextResponse.json({ ok: true, ignored: "missing" });
  }
  const campaign = campaignSnap.data() as VoiceCampaignDoc;
  const rec = recSnap.data() as VoiceCampaignRecipientDoc;

  // Idempotency — settled rows are never re-processed.
  if (rec.status !== "queued") {
    return NextResponse.json({ ok: true, ignored: "already_settled" });
  }

  // Kill switch — the operator stopped the campaign. Skip without dialing.
  // (The cancel route sweeps queued rows; this catches any QStash callback
  // that raced in before that sweep reached this row. A cancel landing
  // later is caught by claimDial just before the dial.)
  if (campaign.status === "cancelled") {
    await skip(recRef, campaignRef, "cancelled");
    return NextResponse.json({ ok: true, status: "skipped", reason: "cancelled" });
  }

  // Live contact read (opt-out may have flipped since fan-out).
  const contactSnap = await db.collection("contacts").doc(contactId).get();
  if (!contactSnap.exists) {
    await skip(recRef, campaignRef, "contact_missing");
    await maybeCompleteCampaign(campaignRef);
    return NextResponse.json({ ok: true, status: "skipped" });
  }
  const contact = {
    id: contactSnap.id,
    ...(contactSnap.data() as Omit<Contact, "id">),
  };

  const channel = await getChannelConfig(campaign.subAccountId, "voice");
  const voice = channel?.voice ?? null;
  if (!voice || voice.outboundEnabled !== true || !voice.vapiAssistantId || !voice.vapiPhoneNumberId) {
    // Channel turned off / un-provisioned mid-campaign — stop dialing.
    await skip(recRef, campaignRef, "scrub_blocked");
    await maybeCompleteCampaign(campaignRef);
    return NextResponse.json({ ok: true, status: "skipped" });
  }

  const profile = await getAgentProfile(campaign.subAccountId);
  const agentTimezone =
    profile?.timezone || voice.outboundWindow?.timezone || "UTC";

  const compliance = await checkOutboundCompliance({
    subAccountId: campaign.subAccountId,
    contact,
    voice,
    agentTimezone,
    consentAck: campaign.consentAck === true,
  });

  if (!compliance.allowed) {
    const code = compliance.code;
    // Deferrable → reschedule (unless we've tried too many times).
    if (code && DEFERRABLE.has(code) && rec.attempts < MAX_ATTEMPTS) {
      const delay =
        code === "outside_window"
          ? Math.max(60, compliance.retryAfterSec ?? 3600)
          : 30; // rate_limited — short backoff
      await recRef.update({ attempts: FieldValue.increment(1) });
      const rescheduled = await publishCallback({
        pathname: "/api/comms/voice/campaign/step",
        body: { campaignId, contactId },
        delaySeconds: delay,
        // Fresh nonce so QStash treats the reschedule as a new message.
        deduplicationId: `vcamp_${campaignId}_${contactId}_a${rec.attempts + 1}`,
      });
      if (!rescheduled) {
        // Nothing will ever run this row again — settle it visibly rather
        // than leave it (and the campaign) queued forever.
        await settleQueuedRecipient(recRef, campaignRef, {
          status: "failed",
          error: "Could not reschedule the call (queue publish failed).",
        });
        await maybeCompleteCampaign(campaignRef);
        return NextResponse.json({ ok: true, status: "failed", code });
      }
      return NextResponse.json({ ok: true, status: "deferred", code });
    }
    // Give up — map the code to a skip reason.
    const reason: VoiceCampaignSkipReason =
      code && DEFERRABLE.has(code)
        ? "window_unreached"
        : ((code as VoiceCampaignSkipReason | undefined) ?? "scrub_blocked");
    await skip(recRef, campaignRef, reason);
    await maybeCompleteCampaign(campaignRef);
    return NextResponse.json({ ok: true, status: "skipped", code });
  }

  // Last gate before dialling: commits the row to "called" unless the
  // campaign was cancelled while the checks above ran.
  const claim = await claimDial(recRef, campaignRef);
  if (claim === "cancelled") {
    return NextResponse.json({ ok: true, status: "skipped", reason: "cancelled" });
  }
  if (claim === "settled") {
    return NextResponse.json({ ok: true, ignored: "already_settled" });
  }

  // Place the call.
  const customerNumber = compliance.e164 ?? contact.phone;
  let callId: string;
  let callControlUrl: string | null = null;
  try {
    const result = await createOutboundCall({
      assistantId: voice.vapiAssistantId,
      phoneNumberId: voice.vapiPhoneNumberId,
      customerNumber,
      contactId,
      campaignId,
      firstMessage: voice.outboundFirstMessage,
    });
    callId = result.callId;
    callControlUrl = result.controlUrl;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Vapi call failed";
    // claimDial counted the row as called — move it to failed.
    await recRef.update({
      status: "failed",
      error: msg,
      settledAt: FieldValue.serverTimestamp(),
    });
    await campaignRef.update({
      "totals.failed": FieldValue.increment(1),
      "totals.called": FieldValue.increment(-1),
    });
    await maybeCompleteCampaign(campaignRef);
    return NextResponse.json({ ok: true, status: "failed" });
  }

  // voiceCalls placeholder (counts toward the gate's caps + shows in the
  // operator console). Mirrors the single-call route's placeholder.
  try {
    await db
      .doc(`subAccounts/${campaign.subAccountId}/voiceCalls/${callId}`)
      .set(
        {
          id: callId,
          agencyId: campaign.agencyId,
          subAccountId: campaign.subAccountId,
          callId,
          direction: "outbound",
          callerPhone: customerNumber,
          toPhone: null,
          durationSec: 0,
          summary: null,
          endedReason: null,
          contactId,
          contactCreated: false,
          callbackRequested: false,
          capturedName: null,
          capturedEmail: null,
          capturedPhone: null,
          taskId: null,
          escalationEmailSent: false,
          transcript: [],
          liveStatus: "queued",
          liveStatusAt: FieldValue.serverTimestamp(),
          campaignId,
          consentAck: true,
          errors: [],
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
  } catch (err) {
    console.warn("[voice/campaign/step] voiceCalls placeholder failed", err);
  }

  await recRef.update({ callId, callControlUrl });

  // Stamp the contact for cross-campaign "don't re-call recently contacted"
  // suppression (read by the audience resolver on future campaigns).
  await db
    .collection("contacts")
    .doc(contactId)
    .update({
      lastOutboundCallAt: FieldValue.serverTimestamp(),
      lastOutboundCampaignId: campaignId,
    })
    .catch((err) =>
      console.warn("[voice/campaign/step] contact stamp failed", err),
    );

  // Activity row on the contact timeline.
  await db
    .collection("contacts")
    .doc(contactId)
    .collection("activities")
    .add({
      type: "voice_call_initiated",
      content: "Outbound AI call placed (campaign)",
      createdBy: "voice-campaign",
      meta: { callId, campaignId },
      createdAt: FieldValue.serverTimestamp(),
    })
    .catch((err) =>
      console.warn("[voice/campaign/step] activity write failed", err),
    );

  await maybeCompleteCampaign(campaignRef);
  return NextResponse.json({ ok: true, status: "called", callId });
}

function skip(
  recRef: FirebaseFirestore.DocumentReference,
  campaignRef: FirebaseFirestore.DocumentReference,
  reason: VoiceCampaignSkipReason,
): Promise<boolean> {
  return settleQueuedRecipient(recRef, campaignRef, {
    status: "skipped",
    skippedReason: reason,
  });
}
