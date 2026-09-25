import "server-only";

import { sendConversationMessage, type SendOutcome } from "@/lib/server/conversation-send";
import { askOutcomeOf, logInboxReviewAsk } from "@/lib/reviews/review-ask";
import { CapabilityOutcomeUnknown, CapabilityUserError, type AiSuiteCapability } from "./types";
import { approvedRecipient, outgoingApprovalTarget, outgoingParameters, outgoingPreview, validateOutgoing } from "./outgoing-message";

/**
 * send_message for API agents (AGENT_API_V1_PLAN.md, PR8). Always a proposal
 * (`outbound`): the approver sees the full body, the channel and the
 * resolved recipient, and the exact address is PINNED. On approve it goes
 * out through the conversation-send seam — the same checks and bookkeeping
 * as the inbox composer — as the approver, to the pinned address only: a
 * recipient that changed since it was reviewed is refused, never followed.
 */

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
      properties: outgoingParameters,
      required: ["conversationId", "channel", "body"],
      additionalProperties: false,
    },
    validate: validateOutgoing,
    summarize: (args) => `Send a ${args.channel} message.`,
    approvalTarget: outgoingApprovalTarget,
    preview: (ctx, args) =>
      outgoingPreview(ctx, args, [
        {
          label: "When",
          value:
            args.channel === "whatsapp"
              ? "Sends when approved, unless the WhatsApp bridge's quiet hours refuse it (then it fails and nothing is sent)."
              : "Sends immediately when approved (quiet hours don't hold it).",
        },
      ]),
    execute: async (ctx, args) => {
      // Approval, pin, live recipient and consent all checked; addressed to the pin.
      const { channel, contactId, sendTo, pinned } = await approvedRecipient(ctx, ctx.subAccountId!, args, "send_message");
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
          ...(channel === "whatsapp" && ctx.approved?.proposalId
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
