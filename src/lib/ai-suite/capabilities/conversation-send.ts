import "server-only";

import { sendConversationMessage, type SendableChannel } from "@/lib/server/conversation-send";
import type { Contact } from "@/types/contacts";
import { CapabilityOutcomeUnknown, CapabilityUserError, type AiSuiteCapability } from "./types";
import { str } from "./helpers";
import { hasUnsafeText, messageBody, oneLine } from "./text-safety";
import { tenantContact } from "./contact-edit";
import { conversationIdParam, conversationTarget, tenantConversation } from "./conversations-read";

/**
 * send_message for API agents (AGENT_API_V1_PLAN.md, PR8). Always a proposal
 * (`outbound`): the approver sees the full body, the channel and the
 * resolved recipient, and the exact address is PINNED. On approve it goes
 * out through the conversation-send seam — the same checks and bookkeeping
 * as the inbox composer — as the approver, to the pinned address only: a
 * recipient that changed since it was reviewed is refused, never followed.
 */

const CHANNELS = ["sms", "whatsapp", "email", "messenger", "instagram"] as const;
const MAX_BODY = 5000;
const MAX_SUBJECT = 200;

/** The address a message on `channel` goes to, from the stored contact. */
function recipientOf(channel: SendableChannel, contact: FirebaseFirestore.DocumentData): string {
  const v = channel === "email" ? contact.email : channel === "sms" || channel === "whatsapp" ? contact.phone : contact.metaUserId;
  return typeof v === "string" ? v : "";
}

/** `contact` with the channel's address set to `to` (the pinned value). */
function withRecipient(channel: SendableChannel, contact: FirebaseFirestore.DocumentData, to: string) {
  const field = channel === "email" ? "email" : channel === "sms" || channel === "whatsapp" ? "phone" : "metaUserId";
  return { ...contact, [field]: to };
}

/** Enough of the address for a person to recognise it. */
function masked(channel: SendableChannel, to: string): string {
  if (channel === "email") {
    const [user, domain] = to.split("@");
    return `${user.slice(0, 1)}***@${domain ?? ""}`;
  }
  if (channel === "sms" || channel === "whatsapp") return `…${to.slice(-4)}`;
  return `account …${to.slice(-4)}`;
}

/** The conversation's contact, both re-anchored to the sub-account. */
async function resolveContact(subAccountId: string, conversationId: unknown) {
  const conv = await tenantConversation(subAccountId, conversationId);
  if (!conv.contactId) throw new CapabilityUserError("Replies to an anonymous web chat can't be sent from here.");
  const contact = await tenantContact(subAccountId, conv.contactId as string);
  return { contactId: conv.contactId as string, contact };
}

export const CONVERSATION_SEND_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "send_message",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["agent"],
    approval: "outbound",
    menuLabel: "Send a message in a conversation (a person approves)",
    description:
      "Send a message to a conversation's contact on sms, whatsapp, email (needs a subject), messenger or instagram. Queued for a person to approve; it goes to the address they reviewed.",
    parameters: {
      type: "object",
      properties: {
        conversationId: conversationIdParam,
        channel: { type: "string", enum: [...CHANNELS] },
        body: { type: "string", description: "The full message text." },
        subject: { type: "string", description: "Email only." },
      },
      required: ["conversationId", "channel", "body"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      const conversationId = str(raw, "conversationId");
      const channel = str(raw, "channel") as SendableChannel;
      const body = typeof r.body === "string" ? messageBody(r.body) : "";
      const subject = str(raw, "subject");
      if (!conversationId) return { ok: false, error: "a conversationId is required" };
      if (!(CHANNELS as readonly string[]).includes(channel)) return { ok: false, error: `channel must be one of ${CHANNELS.join(", ")}` };
      // Line breaks are text in a message; nothing else invisible is.
      if (body === null) return { ok: false, error: "the message can't contain control or invisible characters" };
      if (!body) return { ok: false, error: "a message body is required" };
      if (body.length > MAX_BODY) return { ok: false, error: `the message must be at most ${MAX_BODY} characters` };
      if (channel === "email" && !subject) return { ok: false, error: "an email needs a subject" };
      if (subject.length > MAX_SUBJECT || hasUnsafeText(subject)) return { ok: false, error: "that subject isn't valid" };
      return { ok: true, args: { conversationId, channel, body, ...(channel === "email" ? { subject } : {}) } };
    },
    summarize: (args) => `Send a ${args.channel} message.`,
    approvalTarget: conversationTarget,
    preview: async (ctx, args) => {
      const channel = args.channel as SendableChannel;
      const { contactId, contact } = await resolveContact(ctx.subAccountId!, args.conversationId);
      const to = recipientOf(channel, contact);
      if (!to) throw new CapabilityUserError(`This contact has no ${channel === "email" ? "email address" : channel === "sms" || channel === "whatsapp" ? "phone number" : `${channel} account`}.`);
      return {
        rows: [
          { label: "To", value: `${oneLine(contact.name) || "(unnamed)"} (${masked(channel, to)})` },
          { label: "Channel", value: channel },
          ...(args.subject ? [{ label: "Subject", value: String(args.subject) }] : []),
          // Exactly as it will be sent, line breaks included.
          { label: "Message", value: String(args.body), multiline: true },
        ],
        pinned: { contactId, channel, to },
      };
    },
    execute: async (ctx, args) => {
      if (!ctx.approved) throw new CapabilityUserError("send_message only runs when a person approves it.");
      const pinned = ctx.approved.pinned;
      if (!pinned || pinned.channel !== args.channel || typeof pinned.to !== "string" || !pinned.to) {
        throw new CapabilityUserError("Nothing reviewed to send to: the proposal carries no pinned recipient.");
      }
      const channel = pinned.channel as SendableChannel;
      const { contactId, contact } = await resolveContact(ctx.subAccountId!, args.conversationId);
      if (contactId !== pinned.contactId || recipientOf(channel, contact) !== pinned.to) {
        throw new CapabilityUserError("The recipient changed since this was reviewed; nothing was sent.");
      }
      const outcome = await sendConversationMessage({
        channel,
        contactId,
        // The pinned address, not a fresh lookup (they match, checked above).
        contact: { ...withRecipient(channel, contact, pinned.to), id: contactId } as Contact,
        body: args.body as string,
        subject: (args.subject as string | undefined) ?? "",
        actor: { uid: ctx.uid, email: ctx.email },
        // A proposal, not a person typing in the thread: full quiet-hours guard.
        humanReply: false,
      });
      if (!outcome.ok) {
        if (outcome.outcomeUnknown) throw new CapabilityOutcomeUnknown(outcome.error);
        throw new CapabilityUserError(outcome.error);
      }
      return { resultText: `Sent the ${channel} message.`, ref: { kind: "message", id: outcome.messageId } };
    },
  },
];
