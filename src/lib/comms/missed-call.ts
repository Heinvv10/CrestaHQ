import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import { reconcileContactFromCapture } from "@/lib/comms/ai/capture";
import { sendSmsForSubAccount } from "@/lib/comms/twilio";
import { smsSendBlock } from "@/lib/comms/sms-consent";
import { isQuietHoursDeferred } from "@/lib/comms/quiet-hours";
import { holdForQuietHours } from "@/lib/comms/quiet-hours-hold";
import { upsertConversationForMessage } from "@/lib/server/conversations-service";
import { readSubAccountSecret } from "@/lib/server/sub-account-secrets";
import { renderMergeTags } from "@/lib/messaging/merge-tags";
import type { MissedCallConfig, SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";
import { runAfterResponse } from "@/lib/server/after-response";

/**
 * Missed Call Text Back (MCTB) server helpers.
 *
 * MCTB points a dedicated Twilio number's Voice URL at our handler
 * (/api/webhooks/twilio/voice). That handler forwards the call to the
 * business's real phone; if the forward goes unanswered, Twilio calls the
 * status endpoint (/api/webhooks/twilio/voice/status) which invokes
 * `handleMissedCall` to auto-text the caller.
 *
 * Everything here is scoped to sub-accounts with dedicated Twilio enabled AND
 * the agency gate on AND `twilioConfig.missedCall.enabled` — the same three
 * conditions the settings + config route enforce. Strictly additive: it never
 * touches the SMS inbound path or the Vapi voice pipeline.
 */

export const DEFAULT_MCTB_MESSAGE =
  "Sorry we missed your call! Reply to this text and we'll help you right away.";
export const DEFAULT_MCTB_RING_TIMEOUT_SEC = 20;

/** Twilio Dial statuses that mean the forward didn't connect to a human. */
const MISSED_STATUSES = new Set(["no-answer", "busy", "failed", "canceled"]);

export function isMissedDialStatus(status: string | undefined | null): boolean {
  return !!status && MISSED_STATUSES.has(status.trim().toLowerCase());
}

export function normalisePhone(s: string): string {
  let cleaned = s.trim().replace(/[\s\-()]/g, "");
  if (cleaned.startsWith("00")) cleaned = "+" + cleaned.slice(2);
  return cleaned;
}

export interface VoiceRoute {
  subAccountId: string;
  agencyId: string;
  authToken: string;
  subAccount: SubAccountDoc;
  missedCall: MissedCallConfig;
}

/**
 * Resolve the sub-account that owns an inbound number for MCTB. Returns null
 * unless the number belongs to a sub-account with dedicated Twilio enabled,
 * the agency gate on, and MCTB switched on — so a number whose MCTB was turned
 * off (but whose Voice URL hasn't been repointed yet) is treated as unrouted.
 */
export async function resolveVoiceRoute(
  toNumber: string,
): Promise<VoiceRoute | null> {
  if (!toNumber) return null;
  const normalisedTo = normalisePhone(toNumber);

  const snap = await getAdminDb()
    .collection("subAccounts")
    .where("twilioConfig.fromNumber", "==", normalisedTo)
    .where("twilioConfig.enabled", "==", true)
    .limit(1)
    .get();
  if (snap.empty) return null;

  const doc = snap.docs[0];
  const sa = { id: doc.id, ...(doc.data() as Omit<SubAccountDoc, "id">) };
  const cfg = sa.twilioConfig;
  const mctb = cfg?.missedCall ?? null;
  if (
    sa.missedCallTextBackEnabledByAgency !== true ||
    !mctb?.enabled ||
    !mctb.forwardTo
  ) {
    return null;
  }
  const authToken = await readSubAccountSecret(doc.id, "twilio", cfg);
  if (!authToken) return null;

  return {
    subAccountId: doc.id,
    agencyId: sa.agencyId,
    authToken,
    subAccount: sa,
    missedCall: mctb,
  };
}

/**
 * Render the text-back body through the shared merge-tag renderer, so a
 * missed caller (often a brand-new contact with no name) never sees a broken
 * template: {{contact.firstName}} / {{firstName}} and
 * {{workspace.name}} / {{businessName}} keep working (same signature and
 * output as the old replace chain), {{contact.first_name}} /
 * {{business.name}} work too, and any other tag — or one without a value —
 * collapses to empty. Only the caller's first name is passed in, so the
 * other {{contact.*}} tags always collapse here.
 */
export function renderMissedCallMessage(
  body: string,
  ctx: { firstName: string; businessName: string },
): string {
  return renderMergeTags(
    body,
    { contact: { name: ctx.firstName }, businessName: ctx.businessName },
    { unknown: "drop" },
  )
    .text.replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Claim a call for handling. Idempotent against Twilio retries: the first call
 * writes the claim doc and returns true; retries see it exists and return
 * false so we never double-text. Admin-SDK only (no client reads → no rules).
 */
async function claimCall(
  subAccountId: string,
  callSid: string,
): Promise<boolean> {
  const ref = getAdminDb()
    .doc(`subAccounts/${subAccountId}/missedCallClaims/${callSid}`);
  try {
    return await getAdminDb().runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (snap.exists) return false;
      tx.set(ref, { callSid, createdAt: FieldValue.serverTimestamp() });
      return true;
    });
  } catch (err) {
    console.warn("[mctb] claim transaction failed", err);
    // Fail open on the claim (better to risk a rare double-text than to drop
    // the text-back entirely on a transient Firestore blip).
    return true;
  }
}

export interface HandleMissedCallResult {
  handled: boolean;
  reason?: string;
  contactId?: string;
  smsSid?: string;
}

/**
 * The core miss → text-back flow: dedup, reconcile the caller to a contact
 * (phone-first, creating one if new), honour SMS opt-out, send the text-back,
 * persist the message row + inbox index, and log a `missed_call` activity.
 * Best-effort throughout — the webhook always returns 200 to Twilio.
 */
export async function handleMissedCall(input: {
  route: VoiceRoute;
  from: string;
  callSid: string;
}): Promise<HandleMissedCallResult> {
  const { route, from, callSid } = input;
  const { subAccountId, agencyId, subAccount, missedCall } = route;

  if (!from) return { handled: false, reason: "no_caller" };

  // Idempotency — one text-back per call.
  if (callSid) {
    const fresh = await claimCall(subAccountId, callSid);
    if (!fresh) return { handled: false, reason: "already_handled" };
  }

  const db = getAdminDb();

  // Reconcile the caller to a contact (create if new). Phone is always known.
  const reconciled = await reconcileContactFromCapture({
    agencyId,
    subAccountId,
    existingContactId: null,
    pageUrl: null,
    source: "voice",
    matchStrategy: "phone-first",
    capture: { name: null, email: null, phone: from },
  });
  if (!reconciled) return { handled: false, reason: "reconcile_failed" };
  const contactId = reconciled.contactId;

  // Load the contact for opt-out + merge context.
  const contactSnap = await db.doc(`contacts/${contactId}`).get();
  const contact = contactSnap.data() as Contact | undefined;
  const firstName = (contact?.name ?? "").trim().split(/\s+/)[0] ?? "";

  // call.missed — the miss itself is the event (Conversations webhook
  // category + speed-to-lead push), independent of whether the text-back
  // below sends, gets suppressed by opt-out, or fails. Emitted once per
  // call (the claim above already deduped Twilio retries). Self-guarded.
  runAfterResponse(() => emitWebhookEvent({
    subAccountId,
    agencyId,
    mode: "live",
    type: "call.missed",
    payload: {
      call: {
        object: "missed_call",
        contact_id: contactId,
        contact_name: contact?.name ?? "",
        from,
        call_sid: callSid || null,
      },
    },
  }));

  // Always log the missed call, even when we suppress the text (opt-out).
  const logActivity = async (content: string) => {
    try {
      await db.collection(`contacts/${contactId}/activities`).add({
        type: "missed_call",
        content,
        createdBy: "twilio_voice",
        meta: { kind: "missed_call", callSid, from },
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (err) {
      console.warn("[mctb] activity write failed", err);
    }
  };

  if (contact && smsSendBlock(contact)) {
    await logActivity(
      `Missed call from ${from}. Text-back suppressed — contact is opted out of SMS.`,
    );
    return { handled: true, reason: "opted_out", contactId };
  }

  const bodyText = renderMissedCallMessage(
    missedCall.messageBody?.trim() || DEFAULT_MCTB_MESSAGE,
    { firstName, businessName: subAccount.name ?? "" },
  );

  let smsSid: string | undefined;
  try {
    const sent = await sendSmsForSubAccount({
      subAccountId,
      subAccount,
      to: from,
      body: bodyText,
    });
    smsSid = sent.sid;
  } catch (err) {
    // Quiet hours: nothing went out. Held and sent when they end, after the
    // contact's SMS opt-out is checked again.
    if (isQuietHoursDeferred(err)) {
      await logActivity(`Missed call from ${from}. Auto-text held for quiet hours.`);
      const held = await holdForQuietHours({
        agencyId,
        subAccountId,
        payload: {
          kind: "message",
          message: { channel: "sms", contactId, to: from, body: bodyText, source: "missed_call" },
        },
        hold: err.hold,
      });
      return { handled: held, reason: held ? "quiet_hours_held" : "send_failed", contactId };
    }
    console.error("[mctb] text-back send failed", err);
    await logActivity(`Missed call from ${from}. Auto-text failed to send.`);
    return { handled: false, reason: "send_failed", contactId };
  }

  // Persist the outbound message row (contact Messages tab) + inbox index.
  try {
    const msgId = smsSid || db.collection("contacts").doc().id;
    await db
      .doc(`contacts/${contactId}/messages/${msgId}`)
      .set(
        {
          agencyId,
          subAccountId,
          contactId,
          direction: "outbound",
          status: "sent",
          body: bodyText,
          from: subAccount.twilioConfig?.fromNumber ?? "",
          to: from,
          twilioMessageSid: smsSid ?? null,
          sentByUid: null,
          error: null,
          readAt: null,
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    await upsertConversationForMessage({
      contactId,
      subAccountId,
      agencyId,
      contactName: contact?.name ?? "",
      contactPhone: contact?.phone ?? from,
      channel: "sms",
      direction: "outbound",
      body: bodyText,
    });
  } catch (err) {
    console.warn("[mctb] message-row / inbox write failed", err);
  }

  await logActivity(
    `Missed call from ${from}. Auto-text sent: "${bodyText}"`,
  );

  return { handled: true, contactId, smsSid };
}
