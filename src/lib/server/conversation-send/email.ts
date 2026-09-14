import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { emailIsConfigured, sendEmail, tenantFrom } from "@/lib/comms/resend";
import { checkQuota } from "@/lib/server/usage-meter";
import { recordSend } from "@/lib/comms/usage";
import { providerAttempted } from "@/lib/comms/provider-attempt";
import type { Contact } from "@/types/contacts";
import type { SubAccountDoc } from "@/types";
import {
  refuse,
  type ChannelSendBase,
  type Prepared,
  type SendOutcome,
  type SendRefusal,
} from "./types";

const MESSAGE_ID = /^<[^\s<>]+@[^\s<>]+>$/;

export interface EmailSendPayload {
  contactId?: unknown;
  subject?: unknown;
  body?: unknown;
  inReplyTo?: unknown;
  references?: unknown;
}

/**
 * Shape of an email send request — header injection, sizes, and the reply
 * headers' RFC 5322 form. Moved verbatim from /api/comms/email/send so the
 * scheduling API refuses exactly what the live route refuses.
 */
export function isValidEmailSendPayload(payload: unknown): payload is {
  contactId: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string[];
} {
  const p = payload as EmailSendPayload | null;
  return !(
    !p ||
    typeof p !== "object" ||
    Array.isArray(p) ||
    typeof p.contactId !== "string" ||
    typeof p.subject !== "string" ||
    typeof p.body !== "string" ||
    p.contactId.includes("/") ||
    p.subject.length > 998 ||
    /[\r\n\x00]/.test(p.subject) ||
    p.body.length > 200000 ||
    (p.inReplyTo !== undefined &&
      (typeof p.inReplyTo !== "string" ||
        !MESSAGE_ID.test(p.inReplyTo) ||
        p.inReplyTo.length > 998)) ||
    (p.references !== undefined &&
      (!Array.isArray(p.references) ||
        p.references.length > 100 ||
        p.references.some(
          (id) => typeof id !== "string" || id.length > 998 || !MESSAGE_ID.test(id)
        )))
  );
}

type EmailPrepared = Prepared<{ subAccount: SubAccountDoc | undefined; to: string }>;

/** Everything that can refuse an email before anything is sent. */
export async function prepareEmailSend(
  contact: Contact
): Promise<EmailPrepared | SendRefusal> {
  if (!contact.email) {
    return refuse(400, "This contact has no email address.");
  }
  const subAccountSnap = await getAdminDb()
    .doc(`subAccounts/${contact.subAccountId}`)
    .get();
  const subAccount = subAccountSnap.data() as SubAccountDoc | undefined;
  if (!emailIsConfigured(subAccount)) {
    return refuse(503, "Email is not configured for this sub-account.");
  }
  return { ok: true, subAccount, to: contact.email };
}

export async function sendConversationEmail(
  input: ChannelSendBase & {
    subject: string;
    inReplyTo?: string;
    references?: string[];
  }
): Promise<SendOutcome> {
  const { contactId, contact, subject, body, actor } = input;
  const prepared = await prepareEmailSend(contact);
  if (!prepared.ok) return prepared;
  const { subAccount } = prepared;

  // Reply-To: prefer the sub-account's nominated reply address (single
  // source of truth — every reply for this client lands consistently in
  // one inbox regardless of which teammate triggered the send). Falls
  // back to the teammate's email if the sub-account hasn't set one yet,
  // which preserves the old behavior for unconfigured deployments.
  const replyTo =
    subAccount?.replyToEmail ||
    (subAccount?.emailProvider === "smtp" ? undefined : (actor.email ?? undefined));

  // Monthly email quota (Usage Metering v1). Fails open.
  const quota = await checkQuota({
    subAccountId: contact.subAccountId,
    unit: "emailsSent",
    subAccount,
  });
  if (!quota.allowed && quota.error) {
    return refuse(429, quota.error.message);
  }

  let messageId: string;
  let saved: boolean | undefined;
  let warning: string | undefined;
  try {
    const result = await sendEmail({
      contactId,
      sentByUid: actor.uid,
      inReplyTo: input.inReplyTo,
      references: input.references,
      to: prepared.to,
      subject,
      text: body,
      replyTo,
      from: tenantFrom(subAccount),
      subAccount: subAccount,
      meter: { subAccountId: contact.subAccountId },
    });
    messageId = result.id;
    saved = result.saved;
    warning = result.warning;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to send email";
    const refusal = refuse(502, message);
    return providerAttempted(err) ? { ...refusal, attempted: true } : refusal;
  }

  try {
    await getAdminDb()
      .collection("contacts")
      .doc(contactId)
      .collection("activities")
      .add({
        type: "email_sent",
        content: `Email: ${subject}`,
        createdBy: actor.uid,
        meta: { messageId, subject },
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.warn("[email/send] activity write failed", err);
  }

  try {
    await recordSend(actor.uid, "email");
  } catch {
    console.warn("[email/send] sent; usage bookkeeping failed");
  }

  return {
    ok: true,
    messageId,
    response: {
      ok: true,
      id: messageId,
      sent: true,
      ...(saved !== undefined ? { saved } : {}),
      ...(warning ? { warning } : {}),
    },
  };
}
