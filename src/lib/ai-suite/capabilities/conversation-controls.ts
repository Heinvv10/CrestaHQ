import "server-only";

import { isDocId } from "@/lib/server/doc-id";
import {
  setConversationBotModeServerSide,
  setConversationStatusServerSide,
} from "@/lib/server/conversation-controls";
import { cancelScheduledMessage } from "@/lib/server/scheduled-messages/service";
import type { ConversationBotMode, ConversationStatus } from "@/types/conversations";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { oneLine, str } from "./helpers";
import { tenantContact } from "./contact-edit";
import { conversationIdParam, conversationTarget, tenantConversation } from "./conversations-read";

/**
 * Conversation controls for API agents (AGENT_API_V1_PLAN.md, PR8). Status and
 * the AI mode's off / suggest are direct writes; turning the AI to `auto`
 * lets it reply to a person unattended, so that one is queued (`outbound`)
 * and runs only when a person approves exactly what they reviewed.
 */

const STATUSES = ["open", "closed", "snoozed"] as const;
const MODES = ["off", "suggest", "auto"] as const;
const notHere = () => new CapabilityUserError("That conversation isn't in this workspace.");

export const CONVERSATION_CONTROL_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "set_conversation_status",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["agent"],
    menuLabel: "Open, close or snooze a conversation",
    description: "Set a conversation's status: open, closed or snoozed.",
    parameters: {
      type: "object",
      properties: { conversationId: conversationIdParam, status: { type: "string", enum: [...STATUSES] } },
      required: ["conversationId", "status"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const conversationId = str(raw, "conversationId");
      const status = str(raw, "status");
      if (!conversationId) return { ok: false, error: "a conversationId is required" };
      if (!(STATUSES as readonly string[]).includes(status)) return { ok: false, error: "status must be open, closed or snoozed" };
      return { ok: true, args: { conversationId, status } };
    },
    summarize: (args) => `Mark a conversation ${args.status}.`,
    execute: async (ctx, args) => {
      await tenantConversation(ctx.subAccountId!, args.conversationId);
      if (!(await setConversationStatusServerSide(args.conversationId as string, ctx.subAccountId!, args.status as ConversationStatus))) {
        throw notHere();
      }
      return { resultText: `Conversation marked ${args.status}.`, ref: { kind: "conversation", id: args.conversationId as string } };
    },
  },
  {
    name: "set_bot_mode",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["agent"],
    // `auto` lets the AI message a person unattended: a person approves it.
    approvalFor: (args) => (args.mode === "auto" ? "outbound" : undefined),
    menuLabel: "Set a conversation's AI mode",
    description:
      "Set a conversation's AI mode: off, suggest (drafts for a person to send) or auto (the AI replies on its own). off and suggest apply at once; auto is queued for a person to approve.",
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
      return {
        rows: [
          { label: "Conversation", value: oneLine(c.contactName) || oneLine(c.visitorLabel) || "(unnamed)" },
          { label: "AI mode", value: `${oneLine(c.botMode) || "auto"} → ${args.mode}` },
          { label: "Effect", value: "The AI will reply to this contact on its own, with no one checking first." },
        ],
        pinned: { conversationId: args.conversationId, mode: args.mode },
      };
    },
    execute: async (ctx, args) => {
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
