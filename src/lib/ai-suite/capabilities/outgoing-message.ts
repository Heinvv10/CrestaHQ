import "server-only";

import type { SendableChannel } from "@/lib/server/conversation-send";
import type { Contact } from "@/types/contacts";
import { CapabilityUserError, type AiSuiteCapability, type PreviewRow } from "./types";
import { str } from "./helpers";
import { hasUnsafeText, messageBody, oneLine, UNSAFE_TEXT_MESSAGE } from "./text-safety";
import { conversationIdParam, conversationTarget } from "./conversations-read";
import { consentBlock, emailEnvelope, masked, recipientOf, resolveContact, withRecipient } from "./conversation-send-support";

/**
 * The machinery every agent message capability shares (send_message,
 * schedule_message): argument validation (a safe, normalised body; a one-line
 * subject), the consent refusal at propose, the preview (recipient, consent,
 * email envelope, the body exactly as sent) with the recipient PINNED, and
 * the approve-time checks that the pin still holds.
 */

export const OUTGOING_CHANNELS = ["sms", "whatsapp", "email", "messenger", "instagram"] as const;
const MAX_BODY = 5000;
const MAX_SUBJECT = 200;

export const outgoingParameters = {
  conversationId: conversationIdParam,
  channel: { type: "string", enum: [...OUTGOING_CHANNELS] },
  body: { type: "string", description: "The full message text." },
  subject: { type: "string", description: "Email only." },
};

/** conversationId / channel / body / subject, validated and normalised. */
export function validateOutgoing(
  raw: unknown
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const conversationId = str(raw, "conversationId");
  const channel = str(raw, "channel") as SendableChannel;
  const body = typeof r.body === "string" ? messageBody(r.body) : "";
  // What is sent is what the approver reads: one line, collapsed.
  const subject = (typeof r.subject === "string" ? r.subject : "").replace(/\s+/g, " ").trim();
  if (!conversationId) return { ok: false, error: "a conversationId is required" };
  if (!(OUTGOING_CHANNELS as readonly string[]).includes(channel)) {
    return { ok: false, error: `channel must be one of ${OUTGOING_CHANNELS.join(", ")}` };
  }
  // Line breaks are text in a message; nothing else invisible is.
  if (body === null) return { ok: false, error: `the message ${UNSAFE_TEXT_MESSAGE}` };
  if (!body) return { ok: false, error: "a message body is required" };
  if (body.length > MAX_BODY) return { ok: false, error: `the message must be at most ${MAX_BODY} characters` };
  if (channel === "email" && !subject) return { ok: false, error: "an email needs a subject" };
  if (subject.length > MAX_SUBJECT) return { ok: false, error: `the subject must be at most ${MAX_SUBJECT} characters` };
  if (hasUnsafeText(subject)) return { ok: false, error: `the subject ${UNSAFE_TEXT_MESSAGE}` };
  return { ok: true, args: { conversationId, channel, body, ...(channel === "email" ? { subject } : {}) } };
}

/** Runs only at propose: an opted-out contact gets no proposal at all. */
export const outgoingApprovalTarget: NonNullable<AiSuiteCapability["approvalTarget"]> = async (ctx, args) => {
  const { contact } = await resolveContact(ctx.subAccountId!, args.conversationId);
  const blocked = consentBlock(args.channel as SendableChannel, contact);
  if (blocked) throw new CapabilityUserError(blocked);
  return conversationTarget(ctx, args);
};

/** The preview, with `whenRows` saying when it goes out; pins the recipient. */
export async function outgoingPreview(
  ctx: Parameters<NonNullable<AiSuiteCapability["preview"]>>[0],
  args: Record<string, unknown>,
  whenRows: PreviewRow[]
): Promise<{ rows: PreviewRow[]; pinned: Record<string, unknown> }> {
  const channel = args.channel as SendableChannel;
  const { contactId, contact } = await resolveContact(ctx.subAccountId!, args.conversationId);
  const to = recipientOf(channel, contact);
  if (!to) {
    throw new CapabilityUserError(
      `This contact has no ${channel === "email" ? "email address" : channel === "sms" || channel === "whatsapp" ? "phone number" : `${channel} account`}.`
    );
  }
  // An opt-out after the proposal changes this row: the approver looks again.
  const blocked = consentBlock(channel, contact);
  const env = channel === "email" ? await emailEnvelope(ctx.subAccountId!, contactId) : null;
  return {
    rows: [
      { label: "To", value: `${oneLine(contact.name) || "(unnamed)"} (${masked(channel, to)})` },
      { label: "Channel", value: channel },
      { label: "Consent", value: blocked ? `${blocked} It will not be sent.` : `Not opted out of ${channel}.` },
      ...whenRows,
      ...(env ? [{ label: "From", value: env.from }, { label: "Reply-To", value: env.replyTo }] : []),
      ...(env?.inReplyToLabel ? [{ label: "In reply to", value: env.inReplyToLabel }] : []),
      ...(args.subject ? [{ label: "Subject", value: String(args.subject) }] : []),
      // Exactly as it will be sent, line breaks included.
      { label: "Message", value: String(args.body), multiline: true as const },
    ],
    pinned: { contactId, channel, to, ...(env ? { inReplyTo: env.inReplyTo, references: env.references } : {}) },
  };
}

/**
 * Approve-time checks for a message capability: it runs only inside an
 * approval, with a pinned recipient, the live address still the pinned one,
 * and the contact not opted out since. Returns the contact addressed to the
 * PINNED value (never a fresh lookup) and the pin.
 */
export async function approvedRecipient(
  ctx: Parameters<AiSuiteCapability["execute"]>[0],
  subAccountId: string,
  args: Record<string, unknown>,
  capability: string
) {
  if (!ctx.approved) throw new CapabilityUserError(`${capability} only runs when a person approves it.`);
  const pinned = ctx.approved.pinned;
  if (!pinned || pinned.channel !== args.channel || typeof pinned.to !== "string" || !pinned.to) {
    throw new CapabilityUserError("Nothing reviewed to send to: the proposal carries no pinned recipient.");
  }
  const channel = pinned.channel as SendableChannel;
  const { contactId, contact } = await resolveContact(subAccountId, args.conversationId);
  if (contactId !== pinned.contactId || recipientOf(channel, contact) !== pinned.to) {
    throw new CapabilityUserError("The recipient changed since this was reviewed; nothing was sent.");
  }
  const blocked = consentBlock(channel, contact);
  if (blocked) throw new CapabilityUserError(blocked);
  const sendTo = { ...withRecipient(channel, contact, pinned.to), id: contactId } as Contact;
  return { channel, contactId, sendTo, pinned, to: pinned.to };
}
