import "server-only";

import { NextResponse } from "next/server";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { qstashIsConfigured, verifyQStashSignature } from "@/lib/automations/qstash";
import { sendEmail, emailIsConfigured, tenantFrom } from "@/lib/comms/resend";
import { isEmailSuppressedError } from "@/lib/comms/email-suppression";
import { checkQuota } from "@/lib/server/usage-meter";
import { providerAttempted } from "@/lib/comms/provider-attempt";
import { resolveMergeTags } from "@/lib/automations/merge-tags";
import { buildUnsubscribeUrl } from "@/lib/automations/unsubscribe-token";
import { logIfReviewAsk } from "@/lib/reviews/review-ask";
import { claimSend } from "@/lib/broadcasts/claim-send";
import {
  releaseClaim,
  settleSend,
  type ClaimedRow,
} from "@/lib/broadcasts/settle-send";
import { maybeMarkBroadcastCompleted } from "@/lib/broadcasts/completion";
import { templateFingerprint } from "@/lib/broadcasts/approved";
import type {
  AgencyDoc,
  BroadcastDoc,
  BroadcastSkipReason,
  MessageTemplateDoc,
  SubAccountDoc,
} from "@/types";
import type { Contact } from "@/types/contacts";

export const dynamic = "force-dynamic";

interface StepBody {
  broadcastId?: string;
  contactId?: string;
}

/**
 * Per-recipient bulk email send. Driven by a QStash callback published from
 * /api/broadcasts/email/send. Security comes from the Upstash-Signature
 * header — the route is in PUBLIC_PATHS for the same reason
 * /api/automations/step is.
 *
 * Hot path:
 *   1. Verify signature → claim the send row in a transaction (settled,
 *      already claimed, or broadcast cancelled → no send)
 *   2. Load contact + template + sub-account; honour the agency gate, the
 *      automations kill switch and a disconnected sender
 *   3. Re-check opt-out (operator could have flipped it between fan-out and now)
 *   4. Render merge tags + unsubscribe link → resend.emails.send()
 *   5. Update the send row + atomically increment broadcast totals
 *   6. If this row was the last queued one, flip the broadcast to "completed"
 *
 * Failures during send are caught and recorded as `status: "failed"` rather
 * than re-thrown — a single bounce shouldn't stall the rest of the batch.
 * QStash will not retry because we return 200; that's intentional. We don't
 * want one transient Resend hiccup to retry-storm the whole audience.
 */
export async function POST(request: Request) {
  if (!qstashIsConfigured()) {
    return NextResponse.json(
      { error: "QStash is not configured on this deployment." },
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
  const valid = await verifyQStashSignature(signature, rawBody);
  if (!valid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: StepBody;
  try {
    payload = JSON.parse(rawBody) as StepBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const broadcastId = payload.broadcastId;
  const contactId = payload.contactId;
  if (typeof broadcastId !== "string" || typeof contactId !== "string") {
    return NextResponse.json(
      { error: "Body must include broadcastId (string) and contactId (string)" },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const broadcastRef = db.collection("broadcasts").doc(broadcastId);
  const sendRef = broadcastRef.collection("sends").doc(contactId);

  // Claim the row (idempotency + cancel check) before any side effect.
  const claim = await claimSend(broadcastRef, sendRef);
  if (claim.outcome === "settled_now") {
    await maybeMarkBroadcastCompleted(broadcastRef);
    const status = claim.reason === "cancelled" ? "skipped" : "failed";
    return NextResponse.json({ ok: true, status, reason: claim.reason });
  }
  if (claim.outcome === "in_flight") {
    // Another delivery holds a fresh claim. 503 keeps QStash retrying: if
    // that delivery dies, a later retry finds the claim stale and settles it.
    return NextResponse.json({ error: "Send in flight" }, { status: 503 });
  }
  if (claim.outcome !== "claimed") {
    // A retry after the row settled may be the only chance left to run the
    // completion check the settling delivery never reached.
    if (claim.outcome === "already_settled") await maybeMarkBroadcastCompleted(broadcastRef);
    return NextResponse.json({ ok: true, ignored: claim.outcome });
  }

  const row: ClaimedRow = { sendRef, broadcastRef, claimId: claim.claimId };
  const progress = { providerReached: false };
  try {
    return await deliver(db, row, claim.broadcast, contactId, progress);
  } catch (err) {
    console.error("[broadcasts/step] failed after claim", broadcastId, contactId, err);
    if (!progress.providerReached) {
      // Nothing was sent — release the claim so QStash's retry re-runs the row.
      await releaseClaim(row).catch((e) =>
        console.error("[broadcasts/step] claim release failed", e),
      );
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Step failed" },
      { status: 500 },
    );
  }
}

async function deliver(
  db: FirebaseFirestore.Firestore,
  row: ClaimedRow,
  broadcast: BroadcastDoc,
  contactId: string,
  /** Set just before the provider call: from then on the claim is never released. */
  progress: { providerReached: boolean },
): Promise<Response> {
  const { broadcastRef } = row;
  const broadcastId = broadcastRef.id;
  // Load the contact (live read — opt-out may have flipped since fan-out)
  // along with the template, sub-account, and agency for merge-tag context.
  const contactRef = db.collection("contacts").doc(contactId);
  const [contactSnap, templateSnap, subAccountSnap, agencySnap] =
    await Promise.all([
      contactRef.get(),
      db.collection("message_templates").doc(broadcast.templateId).get(),
      db.collection("subAccounts").doc(broadcast.subAccountId).get(),
      db.collection("agencies").doc(broadcast.agencyId).get(),
    ]);

  const subAccount = subAccountSnap.exists
    ? (subAccountSnap.data() as SubAccountDoc)
    : null;
  // Stops that can flip after the fan-out: the agency gate, the automations
  // kill switch, and the sender being disconnected. Each settles the row
  // terminally with a visible reason — a 5xx here would only make QStash
  // retry a few times and leave the row queued forever.
  if (subAccount?.broadcastsEnabledByAgency !== true || subAccount.automationsPaused === true) {
    await markSkipped(
      row,
      subAccount?.automationsPaused === true ? "automations_paused" : "agency_disabled",
    );
    await maybeMarkBroadcastCompleted(broadcastRef);
    return NextResponse.json({ ok: true, status: "skipped" });
  }
  if (!emailIsConfigured(subAccount)) {
    await markFailed(
      row,
      "Email is not configured for this sub-account (disconnected mid-broadcast). Reconnect it and send again.",
    );
    await maybeMarkBroadcastCompleted(broadcastRef);
    return NextResponse.json({ ok: true, status: "failed" });
  }

  if (!contactSnap.exists) {
    await markSkipped(row, "contact_missing");
    await maybeMarkBroadcastCompleted(broadcastRef);
    return NextResponse.json({ ok: true, status: "skipped" });
  }
  const contact = {
    id: contactSnap.id,
    ...(contactSnap.data() as Omit<Contact, "id">),
  };

  // Live opt-out re-check. Pre-flight ran at fan-out; this catches anyone
  // who unsubscribed mid-batch via the {{unsubscribeLink}} on a prior
  // broadcast or a manual flip in the contact profile.
  if (contact.emailOptedOut) {
    await markSkipped(row, "opt_out");
    await maybeMarkBroadcastCompleted(broadcastRef);
    return NextResponse.json({ ok: true, status: "skipped" });
  }
  if (!contact.email) {
    await markSkipped(row, "no_email");
    await maybeMarkBroadcastCompleted(broadcastRef);
    return NextResponse.json({ ok: true, status: "skipped" });
  }

  if (!templateSnap.exists) {
    await markFailed(
      row,
      `Template ${broadcast.templateId} not found`,
    );
    await maybeMarkBroadcastCompleted(broadcastRef);
    return NextResponse.json({ ok: true, status: "failed" });
  }
  const template = templateSnap.data() as MessageTemplateDoc;
  // An agent's broadcast sends only the template its approver reviewed.
  if (broadcast.approved && templateFingerprint(template) !== broadcast.approved.templateFingerprint) {
    await markFailed(row, "The template changed after this broadcast was approved; not sent.");
    await maybeMarkBroadcastCompleted(broadcastRef);
    return NextResponse.json({ ok: true, status: "failed" });
  }
  const agency = agencySnap.exists ? (agencySnap.data() as AgencyDoc) : null;

  // Owner snapshot for merge tags (matches the automation executor pattern).
  let ownerDisplayName = "";
  let ownerEmail = "";
  if (agency?.ownerUid) {
    try {
      const ownerSnap = await db.collection("users").doc(agency.ownerUid).get();
      const data = ownerSnap.data();
      ownerDisplayName = (data?.displayName as string) ?? "";
      ownerEmail = (data?.email as string) ?? "";
    } catch {
      // Empty strings tolerate cleanly in merge-tag resolution.
    }
  }

  const unsubscribeLink = buildUnsubscribeUrl(contact.id);
  const baseSubject = {
    contact: {
      name: contact.name,
      email: contact.email,
      phone: contact.phone,
      customFields: contact.customFields ?? null,
    },
    owner: { displayName: ownerDisplayName, email: ownerEmail },
    workspace: { name: subAccount?.name ?? "" },
    bookingLink: subAccount?.bookingLink ?? "",
  } as const;

  const text = resolveMergeTags(template.body, {
    ...baseSubject,
    unsubscribeLink,
  });
  const subject = resolveMergeTags(template.subject ?? "", {
    ...baseSubject,
    unsubscribeLink,
  });

  // HTML body: identical render as the automation executor — anchor-tag the
  // unsubscribe link, convert newlines to <br>, wrap in a minimal styled
  // shell. The template BODY is admin-authored and rendered as written; the
  // merge-tag VALUES substituted into it are not, and are escaped below.
  const htmlAnchor = unsubscribeLink
    ? `<a href="${unsubscribeLink}">Unsubscribe</a>`
    : "";
  // Substituted values are escaped for the HTML render (contact fields are
  // untrusted free text); the unsubscribe anchor we build ourselves is not.
  const htmlInner = resolveMergeTags(
    template.body,
    { ...baseSubject, unsubscribeLink: htmlAnchor },
    { escape: "html", safeTags: ["unsubscribeLink"] },
  ).replace(/\r?\n/g, "<br>");
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,sans-serif;line-height:1.6;color:#1a1a1a;max-width:600px;margin:0 auto;padding:24px;">${htmlInner}</body></html>`;

  // Monthly email quota (Usage Metering v1) — record the row as failed
  // with a clear reason rather than silently dropping it. Fails open.
  const quota = await checkQuota({
    subAccountId: broadcast.subAccountId,
    unit: "emailsSent",
    subAccount,
  });
  if (!quota.allowed && quota.error) {
    await markFailed(row, quota.error.message);
    await maybeMarkBroadcastCompleted(broadcastRef);
    return NextResponse.json({ ok: true, status: "failed" });
  }

  let resendMessageId: string | null = null;
  let error: string | null = null;
  let attempted = false;
  progress.providerReached = true;
  try {
    const result = await sendEmail({
      contactId,
      to: contact.email,
      subject: subject || "(no subject)",
      text,
      html,
      replyTo: subAccount?.replyToEmail ?? undefined,
      from: tenantFrom(subAccount),
      subAccount: subAccount,
      meter: { subAccountId: broadcast.subAccountId },
    });
    resendMessageId = result.id;
  } catch (err) {
    if (isEmailSuppressedError(err)) {
      await markSkipped(row, "suppressed");
      await maybeMarkBroadcastCompleted(broadcastRef);
      return NextResponse.json({ ok: true, status: "skipped" });
    }
    error = err instanceof Error ? err.message : "Send failed";
    attempted = providerAttempted(err);
  }
  if (resendMessageId) {
    await settleSend(
      row,
      { status: "sent", resendMessageId, sentAt: FieldValue.serverTimestamp() },
      "totals.sent",
    );
    // Activity row — same shape as a manual send so the timeline reads cleanly.
    await contactRef
      .collection("activities")
      .add({
        type: "email_sent",
        content: `Bulk email: ${broadcast.templateName}`,
        createdBy: "broadcast",
        meta: {
          broadcastId,
          messageId: resendMessageId,
          subject,
        },
        createdAt: FieldValue.serverTimestamp(),
      })
      .catch((err) =>
        console.warn("[broadcasts/step] activity write failed", err),
      );
  } else {
    await settleSend(
      row,
      { status: "failed", error: error ?? "unknown", sentAt: Timestamp.now() },
      "totals.failed",
    );
  }

  // A review link in it makes this recipient's email a review ask (SP5 d1) —
  // logged after the send row is settled (the idempotency marker).
  await logIfReviewAsk({
    sub: subAccount,
    agencyId: broadcast.agencyId,
    subAccountId: broadcast.subAccountId,
    contactId,
    channel: "email",
    source: "broadcast",
    parts: [subject, text],
    createdByUid: "broadcast",
    outcome: resendMessageId
      ? { ok: true, messageSid: resendMessageId }
      : attempted ? { ok: false, failureKind: "send_failed" } : null,
  });

  await maybeMarkBroadcastCompleted(broadcastRef);

  return NextResponse.json({ ok: true });
}

function markSkipped(
  row: ClaimedRow,
  reason: BroadcastSkipReason,
): Promise<boolean> {
  return settleSend(
    row,
    { status: "skipped", skippedReason: reason, sentAt: FieldValue.serverTimestamp() },
    "totals.skipped",
  );
}

function markFailed(
  row: ClaimedRow,
  errorMessage: string,
): Promise<boolean> {
  return settleSend(
    row,
    { status: "failed", error: errorMessage, sentAt: FieldValue.serverTimestamp() },
    "totals.failed",
  );
}
