import "server-only";

import { scheduleConversationMessage } from "@/lib/server/scheduled-messages/service";
import { SCHEDULE_MAX_DAYS, SCHEDULE_MIN_LEAD_MS } from "@/types/scheduled-messages";
import { CapabilityOutcomeUnknown, CapabilityUserError, type AiSuiteCapability } from "./types";
import { fmtInTz, subAccountTimezone } from "./helpers";
import { approvedRecipient, outgoingApprovalTarget, outgoingParameters, outgoingPreview, validateOutgoing } from "./outgoing-message";

/**
 * schedule_message for API agents (AGENT_API_V1_PLAN.md, PR8c). send_message's
 * rules — a safe body shown exactly as sent, consent, the pinned recipient —
 * plus a time. Approving BOOKS the message (an executed row means scheduled);
 * the scheduled-message worker sends it at that time, re-checking the contact
 * and refusing if the address is no longer the pinned one. The booking's doc
 * id comes from the proposal and the claim, so a retry can't book twice.
 */

/** The same window the inbox's "Send later" allows (parseScheduleRequest). */
function sendAtError(ms: number, nowMs: number): string | null {
  if (!Number.isFinite(ms)) return "sendAt must be an ISO date-time";
  if (ms < nowMs + SCHEDULE_MIN_LEAD_MS) return "pick a time at least a minute from now";
  if (ms > nowMs + SCHEDULE_MAX_DAYS * 86_400_000) return `messages can be scheduled up to ${SCHEDULE_MAX_DAYS} days ahead`;
  return null;
}

export const CONVERSATION_SCHEDULE_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "schedule_message",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["agent"],
    approval: "outbound",
    menuLabel: "Schedule a message in a conversation (a person approves)",
    description: `Schedule a message to a conversation's contact for a later time (at least a minute and at most ${SCHEDULE_MAX_DAYS} days ahead), on sms, whatsapp, email (needs a subject), messenger or instagram. Queued for a person to approve; at that time it goes to the address they reviewed, or not at all if it changed.`,
    parameters: {
      type: "object",
      properties: {
        ...outgoingParameters,
        sendAt: { type: "string", description: "When to send, as an ISO 8601 date-time with a timezone offset." },
      },
      required: ["conversationId", "channel", "body", "sendAt"],
      additionalProperties: false,
    },
    // Runs at propose and again at approve: a time that has passed by then is
    // refused, so nothing is ever booked into the past.
    validate: (raw) => {
      const base = validateOutgoing(raw);
      if (!base.ok) return base;
      const r = (raw ?? {}) as Record<string, unknown>;
      const ms = typeof r.sendAt === "string" ? Date.parse(r.sendAt) : Number.NaN;
      const error = sendAtError(ms, Date.now());
      if (error) return { ok: false, error };
      return { ok: true, args: { ...base.args, sendAt: new Date(ms).toISOString() } };
    },
    summarize: (args) => `Schedule a ${args.channel} message for ${args.sendAt}.`,
    approvalTarget: outgoingApprovalTarget,
    preview: async (ctx, args) => {
      const tz = await subAccountTimezone(ctx.subAccountId!);
      const at = new Date(args.sendAt as string);
      return outgoingPreview(ctx, args, [
        { label: "When", value: `${fmtInTz(at, tz)} (${tz}) — ${at.toISOString()}` },
        { label: "Then", value: "Fires at that time; the recipient is re-checked then, and it won't send if it changed." },
      ]);
    },
    execute: async (ctx, args) => {
      const { channel, contactId, sendTo, pinned, to } = await approvedRecipient(ctx, ctx.subAccountId!, args, "schedule_message");
      const sendAt = new Date(args.sendAt as string);
      const error = sendAtError(sendAt.getTime(), Date.now());
      if (error) throw new CapabilityUserError(`Not scheduled: ${error}.`);
      let booked: Awaited<ReturnType<typeof scheduleConversationMessage>>;
      try {
        booked = await scheduleConversationMessage({
          request: {
            contactId,
            channel,
            body: args.body as string,
            subject: channel === "email" ? (args.subject as string) : null,
            inReplyTo: channel === "email" ? ((pinned.inReplyTo as string | null) ?? null) : null,
            references: channel === "email" ? ((pinned.references as string[] | undefined) ?? null) : null,
            sendAt,
          },
          contact: sendTo,
          // The approver books it: the worker re-checks their access at fire.
          actorUid: ctx.uid,
          nowMs: Date.now(),
          pinnedTo: to,
          id: `agent_${ctx.approved!.proposalId}_${ctx.approved!.claimId}`,
        });
      } catch (err) {
        // The doc (and its QStash job) may exist: never "failed".
        console.error("[schedule_message] booking threw", err);
        throw new CapabilityOutcomeUnknown("The message may have been scheduled: something failed while booking it. Check the contact's scheduled messages.");
      }
      if (!booked.ok) throw new CapabilityUserError(booked.error);
      return { resultText: `Scheduled the ${channel} message for ${sendAt.toISOString()}.`, ref: { kind: "scheduledMessage", id: booked.id } };
    },
  },
];
