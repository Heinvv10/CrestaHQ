import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { isDocId } from "@/lib/server/doc-id";
import { listScheduledMessages } from "@/lib/server/scheduled-messages/service";
import { scopedDocs, territoryScopeFor } from "@/lib/ai-suite/territory-scope";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { str, toDate } from "./helpers";
import { oneLine } from "./text-safety";
import { tenantContact } from "./contact-edit";

/**
 * Conversation reads for API agents (AGENT_API_V1_PLAN.md, PR8). Every
 * model-supplied id passes isDocId and is re-anchored to `ctx.subAccountId`;
 * stored text is printed one line per value. Read results are never logged
 * (the REST / MCP read-tool rule).
 */

/** The conversation, or a CapabilityUserError when it is not in `subAccountId`. */
export async function tenantConversation(
  subAccountId: string,
  conversationId: unknown
): Promise<FirebaseFirestore.DocumentData> {
  const data = isDocId(conversationId)
    ? (await getAdminDb().doc(`conversations/${conversationId}`).get()).data()
    : undefined;
  if (!data || data.subAccountId !== subAccountId) {
    throw new CapabilityUserError("That conversation isn't in this workspace.");
  }
  return data;
}

/** The approver's territory gate targets the conversation's contact (or,
 *  for an anonymous web chat, the conversation's own territory). */
export const conversationTarget: NonNullable<AiSuiteCapability["approvalTarget"]> = async (ctx, args) => {
  const c = await tenantConversation(ctx.subAccountId!, args.conversationId);
  return { contactId: (c.contactId as string | null) ?? null, territoryId: (c.territoryId as string | null) ?? null, scoped: true };
};

export const conversationIdParam = { type: "string", description: "The conversation's id (from find_conversations)." };
const STATUSES = ["open", "closed", "snoozed"] as const;
/** find_conversations searches at most this many of the newest conversations. */
const SCAN_CAP = 200;
const iso = (v: unknown) => toDate(v)?.toISOString() ?? "(unknown)";
const nameOf = (c: FirebaseFirestore.DocumentData) =>
  oneLine(c.contactName) || oneLine(c.visitorLabel) || "(unnamed)";

const MESSAGE_CAP = 20;
const millis = (v: unknown) => toDate(v)?.getTime() ?? 0;

/**
 * The newest messages of a thread from every source the inbox thread view
 * reads (conversation-thread.tsx): a web chat's session transcript, or the
 * contact's email / SMS / WhatsApp / Messenger-Instagram rows — merged by
 * time, labelled by channel, capped at MESSAGE_CAP, oldest first.
 */
async function recentMessages(
  subAccountId: string,
  c: FirebaseFirestore.DocumentData
): Promise<Array<{ channel: string; direction: unknown; body: unknown; createdAt: unknown }>> {
  const db = getAdminDb();
  const newest = (path: string) => db.collection(path).orderBy("createdAt", "desc").limit(MESSAGE_CAP).get();
  const sources: Array<[string | null, string]> = isDocId(c.sessionId)
    ? [["web chat", `subAccounts/${subAccountId}/webChatSessions/${c.sessionId}/messages`]]
    : isDocId(c.contactId)
      ? [
          ["email", `contacts/${c.contactId}/emailMessages`],
          ["sms", `contacts/${c.contactId}/messages`],
          ["whatsapp", `contacts/${c.contactId}/whatsappMessages`],
          [null, `contacts/${c.contactId}/metaMessages`], // channel per row
        ]
      : [];
  const snaps = await Promise.all(sources.map(([, path]) => newest(path)));
  return snaps
    .flatMap((snap, i) =>
      snap.docs
        .map((d) => d.data())
        .filter((m) => m.subAccountId === subAccountId)
        .map((m) => ({
          channel: sources[i]![0] ?? (oneLine(m.channel) || "meta"),
          direction: m.direction,
          body: m.subject ? `${m.subject} — ${m.body ?? ""}` : m.body,
          createdAt: m.createdAt,
        }))
    )
    .sort((a, b) => millis(b.createdAt) - millis(a.createdAt))
    .slice(0, MESSAGE_CAP)
    .reverse();
}

export const CONVERSATION_READ_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "find_conversations",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    surfaces: ["agent"],
    menuLabel: "Find conversations in the inbox",
    description:
      "List this sub-account's most recent conversations (newest first), optionally filtered by status or by a contact name / phone / email fragment.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional name, phone or email fragment." },
        status: { type: "string", enum: [...STATUSES] },
      },
      additionalProperties: false,
    },
    validate: (raw) => {
      const status = str(raw, "status");
      if (status && !(STATUSES as readonly string[]).includes(status)) return { ok: false, error: "status must be open, closed or snoozed" };
      return { ok: true, args: { query: str(raw, "query").slice(0, 120), status } };
    },
    summarize: () => "Find conversations.",
    execute: async (ctx, args) => {
      const q = (args.query as string).toLowerCase();
      const scanned = await scopedDocs(
        await territoryScopeFor(ctx),
        getAdminDb()
          .collection("conversations")
          .where("subAccountId", "==", ctx.subAccountId!)
          .orderBy("lastMessageAt", "desc")
          .limit(SCAN_CAP + 1)
      );
      // Only the newest SCAN_CAP are searched: a capped scan says so.
      const capped = scanned.length > SCAN_CAP;
      const flag = capped ? { truncated: true as const } : {};
      const note = capped ? `Searched the ${SCAN_CAP} most recent conversations only; older ones weren't searched.` : "";
      const rows = scanned
        .slice(0, SCAN_CAP)
        .map((d) => ({ id: d.id, c: d.data() }))
        .filter(({ c }) => !args.status || c.status === args.status)
        .filter(({ c }) => !q || [c.contactName, c.contactPhone, c.contactEmail, c.visitorLabel].some((v) => String(v ?? "").toLowerCase().includes(q)))
        .slice(0, 20);
      if (rows.length === 0) return { resultText: ["No conversations matched.", note].filter(Boolean).join(" "), ...flag };
      return {
        ...flag,
        resultText: (note ? `${note}\n` : "") + rows
          .map(({ id, c }) =>
            `- ${nameOf(c)} — id: ${id} · ${oneLine(c.status) || "open"} · last ${oneLine(c.lastChannel)} ${oneLine(c.lastDirection)} ${iso(c.lastMessageAt)}: “${oneLine(c.lastMessagePreview)}”`
          )
          .join("\n"),
      };
    },
  },
  {
    name: "get_conversation",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    surfaces: ["agent"],
    menuLabel: "Read a conversation",
    description:
      "Read one conversation: its status, AI mode, channels, and its 20 most recent messages across every channel (email, SMS, WhatsApp, Messenger / Instagram, or the web-chat transcript).",
    parameters: { type: "object", properties: { conversationId: conversationIdParam }, required: ["conversationId"], additionalProperties: false },
    validate: (raw) => {
      const conversationId = str(raw, "conversationId");
      return conversationId ? { ok: true, args: { conversationId } } : { ok: false, error: "a conversationId is required" };
    },
    summarize: () => "Read a conversation.",
    execute: async (ctx, args) => {
      const c = await tenantConversation(ctx.subAccountId!, args.conversationId);
      const lines = [
        `Contact: ${nameOf(c)}${c.contactId ? ` (contact id: ${oneLine(c.contactId)})` : ""}`,
        `Status: ${oneLine(c.status) || "open"} · AI mode: ${oneLine(c.botMode) || "auto"}`,
        `Channels: ${Array.isArray(c.channelsSeen) ? c.channelsSeen.map(oneLine).join(", ") : oneLine(c.lastChannel)}`,
      ];
      const own = await recentMessages(ctx.subAccountId!, c);
      lines.push(`Messages (${own.length}, newest ${MESSAGE_CAP} at most):`);
      for (const m of own) {
        lines.push(`- ${iso(m.createdAt)} ${m.channel} ${oneLine(m.direction)}: ${oneLine(m.body).slice(0, 500)}`);
      }
      return { resultText: lines.join("\n") };
    },
  },
  {
    name: "list_scheduled_messages",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    surfaces: ["agent"],
    menuLabel: "List a contact's scheduled messages",
    description: "List the messages scheduled for a contact (soonest first), with their status.",
    parameters: {
      type: "object",
      properties: { contactId: { type: "string", description: "The contact's id." } },
      required: ["contactId"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const contactId = str(raw, "contactId");
      return contactId ? { ok: true, args: { contactId } } : { ok: false, error: "a contactId is required" };
    },
    summarize: () => "List scheduled messages.",
    execute: async (ctx, args) => {
      await tenantContact(ctx.subAccountId!, args.contactId as string);
      const list = await listScheduledMessages(args.contactId as string, ctx.subAccountId!);
      if (list.length === 0) return { resultText: "No scheduled messages." };
      return {
        resultText: list
          .map((m) => `- id: ${m.id} · ${oneLine(m.status)} · ${oneLine(m.channel)} · ${m.sendAt}: ${oneLine(m.body).slice(0, 200)}`)
          .join("\n"),
      };
    },
  },
];
