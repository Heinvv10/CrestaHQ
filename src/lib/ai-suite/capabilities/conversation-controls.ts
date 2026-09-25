import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { isDocId } from "@/lib/server/doc-id";
import { setConversationBotModeServerSide } from "@/lib/server/conversation-controls";
import { cancelScheduledMessage } from "@/lib/server/scheduled-messages/service";
import type { ConversationBotMode } from "@/types/conversations";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { str } from "./helpers";
import { oneLine } from "./text-safety";
import { tenantContact } from "./contact-edit";
import { conversationIdParam, conversationTarget, tenantConversation } from "./conversations-read";

/**
 * Conversation controls for API agents (AGENT_API_V1_PLAN.md, PR8). Turning
 * the AI `off` is a direct write; `suggest` and `auto` can each message a
 * person with no one checking first, so they are queued (`outbound`) and run
 * only when a person approves exactly what they reviewed.
 */

const MODES = ["off", "suggest", "auto"] as const;
const EFFECT: Record<string, string> = {
  suggest: "The bot drafts replies for a person to send, but may send holding and out-of-hours replies to web-chat visitors on its own.",
  auto: "The AI replies to people on its own, with no one checking first.",
};

/**
 * AI replies held for quiet hours that this conversation's mode releases.
 * quiet-hours-release sends one only while `conversations/{contactId}` is on
 * auto — the contact-keyed thread — so a web-chat conversation (its own doc
 * id) releases none. A hold being released right now still counts.
 */
async function heldAiReplies(subAccountId: string, conversationId: unknown, contactId: unknown): Promise<number> {
  if (!isDocId(contactId) || conversationId !== contactId) return 0;
  const snap = await getAdminDb()
    .collection(`subAccounts/${subAccountId}/quietHoursHolds`)
    .where("contactId", "==", contactId)
    .where("status", "in", ["pending", "releasing"])
    .get();
  return snap.docs.filter((d) => {
    const p = d.data().payload as { kind?: string; message?: { source?: string } } | undefined;
    return p?.kind === "message" && p.message?.source === "ai_reply";
  }).length;
}
const notHere = () => new CapabilityUserError("That conversation isn't in this workspace.");

export const CONVERSATION_CONTROL_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "set_bot_mode",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["agent"],
    // Every mode but `off` can message a person with no one checking first
    // (auto: AI replies; suggest: web-chat holding / out-of-hours replies),
    // so only `off` is a direct write.
    approvalFor: (args) => (args.mode === "off" ? undefined : "outbound"),
    approvalHint: { approval: "outbound", when: "mode≠off" },
    menuLabel: "Set a conversation's AI mode",
    description:
      "Set a conversation's AI mode: off, suggest (drafts for a person to send) or auto (the AI replies on its own). off applies at once; suggest and auto are queued for a person to approve.",
    parameters: {
      type: "object",
      properties: { conversationId: conversationIdParam, mode: { type: "string", enum: [...MODES] } },
      required: ["conversationId", "mode"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const conversationId = str(raw, "conversationId");
      const mode = str(raw, "mode");
      if (!conversationId) return { ok: false, error: "a conversationId is required" };
      if (!(MODES as readonly string[]).includes(mode)) return { ok: false, error: "mode must be off, suggest or auto" };
      return { ok: true, args: { conversationId, mode } };
    },
    summarize: (args) => `Set a conversation's AI mode to ${args.mode}.`,
    approvalTarget: conversationTarget,
    preview: async (ctx, args) => {
      const c = await tenantConversation(ctx.subAccountId!, args.conversationId);
      const held = args.mode === "auto" ? await heldAiReplies(ctx.subAccountId!, args.conversationId, c.contactId) : 0;
      return {
        rows: [
          { label: "Conversation", value: oneLine(c.contactName) || oneLine(c.visitorLabel) || "(unnamed)" },
          { label: "AI mode", value: `${oneLine(c.botMode) || "auto"} → ${args.mode}` },
          { label: "Effect", value: EFFECT[args.mode as string] ?? "" },
          ...(held > 0
            ? [{ label: "Held replies", value: `${held} AI ${held === 1 ? "reply" : "replies"} held for quiet hours will be released when the hold ends.` }]
            : []),
        ],
        pinned: { conversationId: args.conversationId, mode: args.mode },
      };
    },
    execute: async (ctx, args) => {
      // Only `off` runs outside an approval, whatever dispatch decided.
      if (args.mode !== "off" && !ctx.approved) {
        throw new CapabilityUserError(`Setting the AI to ${String(args.mode)} needs a person's approval.`);
      }
      // On approve, apply exactly what was reviewed; never fall back to args.
      const src = ctx.approved ? ctx.approved.pinned : args;
      if (!src || src.conversationId !== args.conversationId || src.mode !== args.mode) {
        throw new CapabilityUserError("The approved change doesn't match this request.");
      }
      await tenantConversation(ctx.subAccountId!, args.conversationId);
      if (!(await setConversationBotModeServerSide(args.conversationId as string, ctx.subAccountId!, src.mode as ConversationBotMode))) {
        throw notHere();
      }
      return { resultText: `AI mode set to ${src.mode}.`, ref: { kind: "conversation", id: args.conversationId as string } };
    },
  },
  {
    name: "cancel_scheduled_message",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["agent"],
    menuLabel: "Cancel a scheduled message",
    description: "Cancel a pending scheduled message (or dismiss a failed one). Resolve ids with list_scheduled_messages.",
    parameters: {
      type: "object",
      properties: {
        contactId: { type: "string", description: "The contact's id." },
        scheduledMessageId: { type: "string", description: "The scheduled message's id." },
      },
      required: ["contactId", "scheduledMessageId"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const contactId = str(raw, "contactId");
      const scheduledMessageId = str(raw, "scheduledMessageId");
      if (!contactId || !scheduledMessageId) return { ok: false, error: "a contactId and a scheduledMessageId are required" };
      return { ok: true, args: { contactId, scheduledMessageId } };
    },
    summarize: () => "Cancel a scheduled message.",
    execute: async (ctx, args) => {
      await tenantContact(ctx.subAccountId!, args.contactId as string);
      if (!isDocId(args.scheduledMessageId)) throw new CapabilityUserError("Scheduled message not found.");
      const res = await cancelScheduledMessage({
        contactId: args.contactId as string,
        subAccountId: ctx.subAccountId!,
        id: args.scheduledMessageId as string,
        actorUid: ctx.uid,
      });
      if (!res.ok) throw new CapabilityUserError(res.error);
      return {
        resultText: res.action === "cancelled" ? "Scheduled message cancelled." : "Scheduled message dismissed.",
        ref: { kind: "scheduledMessage", id: args.scheduledMessageId as string },
      };
    },
  },
];
