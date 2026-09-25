import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { smsSendBlock } from "@/lib/comms/sms-consent";
import { tenantFrom } from "@/lib/comms/resend";
import { emailReplyFields } from "@/components/conversations/email-reply";
import type { SendableChannel } from "@/lib/server/conversation-send";
import type { EmailMessageDoc } from "@/types/email";
import type { SubAccountDoc } from "@/types";
import { CapabilityUserError } from "./types";
import { tenantContact } from "./contact-edit";
import { toDate } from "./helpers";
import { oneLine } from "./text-safety";
import { tenantConversation } from "./conversations-read";

/**
 * What send_message needs to know about a recipient, as pure functions of
 * stored data so the preview is the same at propose and at approve: the
 * address a channel goes to, a masked form, the consent state, and for
 * email the From / Reply-To / threading the human send route would use.
 */

/** The address a message on `channel` goes to, from the stored contact. */
export function recipientOf(channel: SendableChannel, contact: FirebaseFirestore.DocumentData): string {
  const v = channel === "email" ? contact.email : channel === "sms" || channel === "whatsapp" ? contact.phone : contact.metaUserId;
  return typeof v === "string" ? v : "";
}

/** `contact` with the channel's address set to `to` (the pinned value). */
export function withRecipient(channel: SendableChannel, contact: FirebaseFirestore.DocumentData, to: string) {
  const field = channel === "email" ? "email" : channel === "sms" || channel === "whatsapp" ? "phone" : "metaUserId";
  return { ...contact, [field]: to };
}

/** Enough of the address for a person to recognise it. */
export function masked(channel: SendableChannel, to: string): string {
  if (channel === "email") {
    const [user, domain] = to.split("@");
    return `${user.slice(0, 1)}***@${domain ?? ""}`;
  }
  if (channel === "sms" || channel === "whatsapp") return `…${to.slice(-4)}`;
  return `account …${to.slice(-4)}`;
}

/**
 * Why the contact must not get a message on `channel`, or null. The email
 * seam itself never reads emailOptedOut (only the composer and the scheduled
 * worker do), so this is the agent path's guard, at propose and at approve.
 */
export function consentBlock(channel: SendableChannel, contact: FirebaseFirestore.DocumentData): string | null {
  if (channel === "email" && contact.emailOptedOut === true) return "This contact has opted out of email.";
  if (channel === "whatsapp" && contact.whatsappOptedOut === true) return "This contact has opted out of WhatsApp.";
  if (channel === "sms") {
    const reason = smsSendBlock(contact as Parameters<typeof smsSendBlock>[0]);
    if (reason === "carrier_stop") return "This contact has opted out of SMS (replied STOP).";
    if (reason === "consent_declined") return "This contact declined SMS consent on a form.";
  }
  return null;
}

/** The conversation's contact, both re-anchored to the sub-account. */
export async function resolveContact(subAccountId: string, conversationId: unknown) {
  const conv = await tenantConversation(subAccountId, conversationId);
  if (!conv.contactId) throw new CapabilityUserError("Replies to an anonymous web chat can't be sent from here.");
  const contact = await tenantContact(subAccountId, conv.contactId as string);
  return { contactId: conv.contactId as string, contact };
}

/**
 * An email's envelope, as the composer's reply would build it: threaded onto
 * the thread's newest email (emailReplyFields — the human route passes what
 * that computes), From as tenantFrom, and the Reply-To the email seam picks.
 */
export async function emailEnvelope(subAccountId: string, contactId: string) {
  const db = getAdminDb();
  const [sub, latest] = await Promise.all([
    db.doc(`subAccounts/${subAccountId}`).get().then((s) => s.data() as SubAccountDoc | undefined),
    db.collection(`contacts/${contactId}/emailMessages`).orderBy("createdAt", "desc").limit(1).get(),
  ]);
  const parent = latest.docs.map((d) => d.data() as EmailMessageDoc).find((m) => m.subAccountId === subAccountId) ?? null;
  const reply = emailReplyFields(parent);
  const sent = toDate(parent?.createdAt);
  return {
    // Shown, so a change of thread (a newer email) is visible to the approver.
    inReplyToLabel: parent ? `${oneLine(parent.subject) || "(no subject)"} (${sent ? sent.toISOString() : "unknown date"})` : null,
    from: tenantFrom(sub) ?? "the workspace's default sender",
    replyTo: sub?.replyToEmail || (sub?.emailProvider === "smtp" ? "none" : "the approving person's email"),
    inReplyTo: reply.inReplyTo ?? null,
    references: reply.references,
  };
}
