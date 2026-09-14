import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  sendSmsForSubAccount,
  smsIsConfigured,
  subAccountTwilioIsConfigured,
  SmsRecipientUnsubscribedError,
} from "@/lib/comms/twilio";
import { smsSendBlock } from "@/lib/comms/sms-consent";
import { UsageQuotaExceededError } from "@/lib/server/usage-meter";
import { recordSend } from "@/lib/comms/usage";
import { providerAttempted } from "@/lib/comms/provider-attempt";
import { upsertConversationForMessage } from "@/lib/server/conversations-service";
import type { Contact } from "@/types/contacts";
import type { SubAccountDoc } from "@/types";
import {
  refuse,
  type ChannelSendBase,
  type Prepared,
  type SendOutcome,
  type SendRefusal,
} from "./types";

type SmsPrepared = Prepared<{ subAccount: SubAccountDoc | null; to: string }>;

/**
 * Everything that can refuse an SMS before anything is sent.
 *
 * Mode selection (unchanged from the route this came out of):
 *   - If the contact's sub-account has `twilioConfig.enabled === true`, the
 *     send uses the sub-account's dedicated Twilio creds AND writes a message
 *     row to contacts/{id}/messages so the chat thread renders.
 *   - Otherwise falls back to the env-var Twilio (existing shared-sender
 *     behavior). No message row is written in shared mode — the activity
 *     timeline still records `sms_sent` so nothing visibly regresses.
 */
export async function prepareSmsSend(
  contact: Contact
): Promise<SmsPrepared | SendRefusal> {
  if (!contact.phone) {
    return refuse(400, "This contact has no phone number.");
  }

  // Server-side opt-out gate. The composer disables itself client-side, but
  // a disabled button is not an endpoint guard — every other sender (workflow,
  // AI, missed-call, reviews) already refuses, and carriers hold the
  // registered brand responsible however the message was sent.
  const smsBlock = smsSendBlock(contact);
  if (smsBlock) {
    return refuse(
      409,
      smsBlock === "carrier_stop"
        ? "This contact has opted out of SMS (replied STOP). They must text START to opt back in."
        : "This contact declined SMS consent on a form."
    );
  }

  const subAccountSnap = await getAdminDb()
    .doc(`subAccounts/${contact.subAccountId}`)
    .get();
  const subAccount = subAccountSnap.exists
    ? (subAccountSnap.data() as SubAccountDoc)
    : null;

  // Gate: if neither dedicated nor shared mode is available, refuse.
  if (!subAccountTwilioIsConfigured(subAccount?.twilioConfig) && !smsIsConfigured()) {
    return refuse(503, "SMS is not configured on this deployment.");
  }
  return { ok: true, subAccount, to: contact.phone };
}

export async function sendConversationSms(
  input: ChannelSendBase
): Promise<SendOutcome> {
  const { contactId, contact, body, actor } = input;
  const prepared = await prepareSmsSend(contact);
  if (!prepared.ok) return prepared;
  const { subAccount } = prepared;
  const db = getAdminDb();

  let sid: string;
  let mode: "shared" | "dedicated";
  let fromNumber: string;
  try {
    const result = await sendSmsForSubAccount({
      subAccountId: contact.subAccountId,
      subAccount,
      to: prepared.to,
      body,
    });
    sid = result.sid;
    mode = result.mode;
    fromNumber = result.from;
  } catch (err) {
    if (err instanceof UsageQuotaExceededError) {
      return refuse(429, err.message);
    }
    if (err instanceof SmsRecipientUnsubscribedError) {
      // Authoritative carrier signal — record it so the next attempt is
      // refused up front, and leave the audit trail on the contact
      // (same shape as the inbound STOP webhook's write).
      try {
        await db.doc(`contacts/${contactId}`).update({
          smsOptedOut: true,
          updatedAt: FieldValue.serverTimestamp(),
        });
        await db
          .collection("contacts")
          .doc(contactId)
          .collection("activities")
          .add({
            type: "automation_step_skipped",
            content: `SMS refused by carrier — ${contact.phone} is unsubscribed (Twilio 21610).`,
            createdBy: actor.uid,
            meta: { kind: "sms_opt_out", word: "21610", optedOut: true },
            createdAt: FieldValue.serverTimestamp(),
          });
      } catch (recordErr) {
        console.warn("[sms/send] 21610 opt-out record failed", recordErr);
      }
      return { ...refuse(409, err.message), attempted: true };
    }
    const message = err instanceof Error ? err.message : "Failed to send SMS";
    const refusal = refuse(502, message);
    return providerAttempted(err) ? { ...refusal, attempted: true } : refusal;
  }

  const preview = body.length > 80 ? `${body.slice(0, 80)}…` : body;

  // Activity row — written for both modes so existing UIs that surface
  // sms_sent events keep working.
  try {
    await db
      .collection("contacts")
      .doc(contactId)
      .collection("activities")
      .add({
        type: "sms_sent",
        content: `SMS: ${preview}`,
        createdBy: actor.uid,
        meta: { sid, mode },
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.warn("[sms/send] activity write failed", err);
  }

  // Chat-thread row — only in dedicated mode. Doc id = MessageSid so any
  // accidental retry from the same SID dedupes naturally.
  if (mode === "dedicated") {
    try {
      await db
        .collection("contacts")
        .doc(contactId)
        .collection("messages")
        .doc(sid)
        .set({
          agencyId: contact.agencyId,
          subAccountId: contact.subAccountId,
          contactId,
          direction: "outbound",
          status: "sent",
          body,
          from: fromNumber,
          to: contact.phone,
          twilioMessageSid: sid,
          sentByUid: actor.uid,
          error: null,
          readAt: null,
          createdAt: FieldValue.serverTimestamp(),
        });
    } catch (err) {
      console.warn("[sms/send] message-row write failed", err);
    }

    // Unified-inbox index — mirror this outbound into the conversation doc.
    await upsertConversationForMessage({
      contactId,
      subAccountId: contact.subAccountId,
      agencyId: contact.agencyId,
      contactName: contact.name ?? "",
      contactPhone: contact.phone,
      channel: "sms",
      direction: "outbound",
      body,
      pauseBot: true,
    });
  }

  await recordSend(actor.uid, "sms");

  return { ok: true, messageId: sid, response: { ok: true, sid, mode } };
}
