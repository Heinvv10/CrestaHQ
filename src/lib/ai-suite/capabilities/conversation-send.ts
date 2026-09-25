import "server-only";

import { sendConversationMessage, type SendableChannel, type SendOutcome } from "@/lib/server/conversation-send";
import { askOutcomeOf, logInboxReviewAsk } from "@/lib/reviews/review-ask";
import type { Contact } from "@/types/contacts";
import { CapabilityOutcomeUnknown, CapabilityUserError, type AiSuiteCapability } from "./types";
import { str } from "./helpers";
import { hasUnsafeText, messageBody, oneLine } from "./text-safety";
import { conversationIdParam, conversationTarget } from "./conversations-read";
import { consentBlock, emailEnvelope, masked, recipientOf, resolveContact, withRecipient } from "./conversation-send-support";

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
      // What is sent is what the approver reads: one line, collapsed.
      const subject = (typeof r.subject === "string" ? r.subject : "").replace(/\s+/g, " ").trim();
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
    // Runs only at propose: an opted-out contact gets no proposal at all.
    approvalTarget: async (ctx, args) => {
      const { contact } = await resolveContact(ctx.subAccountId!, args.conversationId);
      const blocked = consentBlock(args.channel as SendableChannel, contact);
      if (blocked) throw new CapabilityUserError(blocked);
      return conversationTarget(ctx, args);
    },
    preview: async (ctx, args) => {
      const channel = args.channel as SendableChannel;
      const { contactId, contact } = await resolveContact(ctx.subAccountId!, args.conversationId);
      const to = recipientOf(channel, contact);
      if (!to) throw new CapabilityUserError(`This contact has no ${channel === "email" ? "email address" : channel === "sms" || channel === "whatsapp" ? "phone number" : `${channel} account`}.`);
      // An opt-out after the proposal changes this row: the approver looks again.
      const blocked = consentBlock(channel, contact);
      const env = channel === "email" ? await emailEnvelope(ctx.subAccountId!, contactId) : null;
      return {
        rows: [
          { label: "To", value: `${oneLine(contact.name) || "(unnamed)"} (${masked(channel, to)})` },
          { label: "Channel", value: channel },
          { label: "Consent", value: blocked ? `${blocked} It will not be sent.` : `Not opted out of ${channel}.` },
          {
            label: "When",
            value:
              channel === "whatsapp"
                ? "Sends when approved, unless the WhatsApp bridge's quiet hours refuse it (then it fails and nothing is sent)."
                : "Sends immediately when approved (quiet hours don't hold it).",
          },
          ...(env ? [{ label: "From", value: env.from }, { label: "Reply-To", value: env.replyTo }] : []),
          ...(env?.inReplyToLabel ? [{ label: "In reply to", value: env.inReplyToLabel }] : []),
          ...(args.subject ? [{ label: "Subject", value: String(args.subject) }] : []),
          // Exactly as it will be sent, line breaks included.
          { label: "Message", value: String(args.body), multiline: true },
        ],
        pinned: {
          contactId, channel, to,
          ...(env ? { inReplyTo: env.inReplyTo, references: env.references } : {}),
        },
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
      // Opted out since it was reviewed: refused before any provider call.
      const blocked = consentBlock(channel, contact);
      if (blocked) throw new CapabilityUserError(blocked);
      // The pinned address, not a fresh lookup (they match, checked above).
      const sendTo = { ...withRecipient(channel, contact, pinned.to), id: contactId } as Contact;
      let outcome: SendOutcome;
      try {
        outcome = await sendConversationMessage({
          channel,
          contactId,
          contact: sendTo,
          body: args.body as string,
          subject: (args.subject as string | undefined) ?? "",
          ...(channel === "email"
            ? {
                inReplyTo: (pinned.inReplyTo as string | null) ?? undefined,
                references: (pinned.references as string[] | undefined) ?? [],
              }
            : {}),
          // One key per approval attempt, like the scheduled worker's: a
          // redelivered WhatsApp bridge send converges instead of repeating.
          ...(channel === "whatsapp" && ctx.approved.proposalId
            ? { idempotencyKey: `agent_${ctx.approved.proposalId}_${ctx.approved.claimId}` }
            : {}),
          actor: { uid: ctx.uid, email: ctx.email },
          // The seam sends as origin "manual" — a person's message, sent now,
          // not held for quiet hours: approving is a human act, and the
          // preview says it sends immediately. humanReply stays false: the
          // bridge's in-session relaxation is for someone typing right now.
          humanReply: false,
        });
      } catch (err) {
        // A throw may come after the provider accepted the message (the
        // thread / usage bookkeeping): never "failed", which invites a resend.
        console.error("[send_message] the send seam threw", err);
        throw new CapabilityOutcomeUnknown(
          "The message may have gone out: something failed during the send. Check the thread before sending again."
        );
      }
      // The human send routes log review requests the same way.
      await logInboxReviewAsk({
        contact: sendTo,
        channel,
        parts: channel === "email" ? [args.subject as string, args.body as string] : [args.body as string],
        actorUid: ctx.uid,
        outcome: askOutcomeOf(outcome),
      });
      if (!outcome.ok) {
        // Once the provider was contacted, even a rejection may have gone
        // out: a person checks it (mark_sent / mark_not_sent). Only a refusal
        // decided before any provider call (opt-out, readiness, window) fails.
        if (outcome.status === 502 || outcome.outcomeUnknown || outcome.attempted) {
          throw new CapabilityOutcomeUnknown(outcome.error);
        }
        throw new CapabilityUserError(outcome.error);
      }
      return { resultText: `Sent the ${channel} message.`, ref: { kind: "message", id: outcome.messageId } };
    },
  },
];
