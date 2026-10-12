import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { aiIsConfigured } from "@/lib/comms/ai/openrouter";
import { aiChannelGateOn } from "@/lib/comms/ai/gates";
import { resolveAgent } from "@/lib/comms/ai/agent";
import { emailTurnText, maybeRespondWithAi } from "@/lib/comms/ai/respond";
import { emailIsConfigured, tenantFrom } from "@/lib/comms/resend";
import { emailReplyFields } from "@/components/conversations/email-reply";
import {
  isAutoReply,
  isDeliveryReport,
  senderAuthenticated,
  type InboundEmail,
} from "@/lib/prospecting/mystery-shop/email-match";
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";

/** One just-imported inbound email, as the mailbox sync recorded it. */
export interface InboundEmailForDraft {
  subAccountId: string;
  contactId: string;
  from: string;
  subject: string;
  body: string;
  messageId: string;
  inReplyTo: string | null;
  references: string[];
}

/**
 * Bounces, auto-replies and list mail have nobody to answer, and mail whose
 * sender the receiving host's checks definitely FAILED (a spoofed From) must
 * not get a reply drafted to that address: no draft for any of them.
 */
export function isDraftableEmail(
  m: Pick<InboundEmail, "autoReply" | "dsn" | "from" | "subject" | "authResults">,
): boolean {
  const domain = m.from.slice(m.from.lastIndexOf("@") + 1);
  return !isAutoReply(m) && !isDeliveryReport(m) && senderAuthenticated(m.authResults, domain) !== "fail";
}

/** The bare address of `Name <a@b>` or `a@b`, lower-cased. */
function addressOf(value: string | null | undefined): string {
  const v = (value ?? "").trim();
  return (/<([^<>]+)>\s*$/.exec(v)?.[1] ?? v).trim().toLowerCase();
}

/**
 * Addresses this workspace sends from or notifies: mail FROM one of them is
 * our own (a notification, a copy of our send) and must never be drafted — or
 * its reply could feed back into the mailbox. The mailbox's own addresses are
 * already skipped by the sync before anything is recorded.
 */
function ownSendingAddresses(sub: SubAccountDoc, escalationNotifyEmail: string | null): Set<string> {
  return new Set(
    [
      process.env.EMAIL_FROM,
      sub.smtpConfig?.fromEmail,
      tenantFrom(sub),
      sub.replyToEmail,
      escalationNotifyEmail,
    ]
      .map(addressOf)
      .filter(Boolean),
  );
}

/**
 * Email AI drafts: write a suggested reply to one inbound email onto the
 * contact's conversation for a person to edit and approve. DRAFT-ONLY — this
 * never sends; maybeRespondWithAi forces suggest mode for the email channel,
 * and the draft goes out only through /api/comms/email/send when a person
 * approves it.
 *
 * Fails closed: nothing is drafted unless the agency gate is on, the
 * sub-account can send email, the channel is enabled, the sender is not one of
 * our own sending addresses, and the contact belongs to this sub-account and
 * is the email's sender. The draft can only answer
 * that contact: its subject and thread headers come from the inbound email,
 * and approval sends to the contact's own address. Never throws, and never
 * logs the email or a raw error.
 */
export async function maybeDraftEmailReply(m: InboundEmailForDraft): Promise<void> {
  try {
    if (!aiIsConfigured()) return;
    const db = getAdminDb();
    const subSnap = await db.doc(`subAccounts/${m.subAccountId}`).get();
    const sub = subSnap.data() as SubAccountDoc | undefined;
    if (!sub?.agencyId) return;
    if (!aiChannelGateOn(sub, "email")) return;
    if (!emailIsConfigured(sub)) return;

    const agent = await resolveAgent(m.subAccountId, "email");
    if (!agent?.effective.enabled) return;
    if (ownSendingAddresses(sub, agent.effective.escalationNotifyEmail).has(addressOf(m.from))) return;

    const contactSnap = await db.doc(`contacts/${m.contactId}`).get();
    if (!contactSnap.exists) return;
    const contact = {
      id: contactSnap.id,
      ...(contactSnap.data() as Omit<Contact, "id">),
    } as Contact;
    const from = m.from.trim().toLowerCase();
    if (
      contact.subAccountId !== m.subAccountId ||
      contact.agencyId !== sub.agencyId ||
      (contact.email ?? "").trim().toLowerCase() !== from
    ) {
      return;
    }

    await maybeRespondWithAi({
      subAccountId: m.subAccountId,
      subAccount: sub,
      agent,
      channelId: "email",
      contact,
      incomingMessage: emailTurnText(m.subject, m.body),
      replyTo: from,
      emailReply: emailReplyFields({
        subject: m.subject,
        messageId: m.messageId,
        inReplyTo: m.inReplyTo,
        references: m.references,
      }),
    });
  } catch (err) {
    console.error(
      `[ai/email-draft] draft failed sa=${m.subAccountId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
