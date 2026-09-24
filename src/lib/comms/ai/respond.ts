import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { sendSmsForSubAccount } from "@/lib/comms/twilio";
import { sendWhatsappFreeFormForSubAccount } from "@/lib/comms/whatsapp/send-dispatch";
import { whatsappSenderIdOnRail } from "@/lib/comms/whatsapp/resolve-sender";
import type { WhatsAppProviderId } from "@/lib/comms/whatsapp/provider";
import {
  detectAiReplyLoop,
  pauseBotForReplyLoop,
  sendReplyLoopNotification,
  type AiLoopReason,
} from "@/lib/comms/ai/loop-guard";
import { sendMetaMessage } from "@/lib/comms/meta";
import { smsSendBlock } from "@/lib/comms/sms-consent";
import { isWithinBusinessHours } from "@/lib/comms/business-hours";
import { checkQuota } from "@/lib/server/usage-meter";
import { callAi, type AiChatMessage } from "@/lib/comms/ai/openrouter";
import {
  incrementChannelTokens,
  type ConfiguredChannelId,
} from "@/lib/comms/ai/agent";
import { buildContactContextBlock } from "@/lib/comms/ai/context";
import { buildSystemPrompt } from "@/lib/comms/ai/prompt";
import {
  matchEscalationKeyword,
  sendEscalationNotification,
} from "@/lib/comms/ai/escalation";
import type { ResolvedAiAgent } from "@/types/ai";
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";
import {
  getConversationControls,
  setConversationDraft,
  upsertConversationForMessage,
} from "@/lib/server/conversations-service";
import type { ConversationChannel } from "@/types/conversations";
import { readSubAccountSecret } from "@/lib/server/sub-account-secrets";

interface RespondInput {
  subAccountId: string;
  subAccount: SubAccountDoc;
  /** Profile + channel config, already merged into effective values by
   *  the webhook caller via resolveAgent(). */
  agent: ResolvedAiAgent;
  /** Which channel this respond run is for. Supported here: "sms",
   *  "whatsapp" (both Twilio) and "meta" (Messenger/Instagram DMs over the
   *  Graph API) — same guards → context → LLM → send → log flow, differing
   *  only in transport (see getChannelTransport). web-chat + voice have
   *  their own orchestrators and never call this. */
  channelId: ConfiguredChannelId;
  contact: Contact;
  /** The just-arrived inbound text. */
  incomingMessage: string;
  /** Reply destination — the caller's phone (Twilio channels) or the
   *  sender's Meta-scoped user id (meta channel). */
  replyTo: string;
  /** REQUIRED when channelId === "meta": which platform the DM arrived on.
   *  The reply mirrors it, and it becomes the conversation/draft channel. */
  metaChannel?: "messenger" | "instagram";
  /** WhatsApp only: the rail the inbound arrived on. The reply goes back out
   *  on the same rail (so from the number the customer wrote to), not on the
   *  workspace's default sender. */
  inboundProvider?: WhatsAppProviderId;
}

type AiSkipReason =
  | "disabled"
  | "no_prompt"
  | "outside_hours"
  | "escalation_keyword"
  | "contact_opted_out"
  | "bot_off"
  | "bot_paused"
  | "quota"
  | "reply_loop"
  | "llm_failed";

type RespondOutcome =
  | { kind: "replied"; replyText: string; tokens: number }
  | { kind: "escalated"; keyword: string }
  | { kind: "drafted"; replyText: string; tokens: number }
  | { kind: "skipped"; reason: AiSkipReason };

/**
 * Per-channel transport. The orchestrator is identical across SMS, WhatsApp
 * and Meta DMs; only the message-thread subcollection, the opt-out flag, the
 * provider send, the outbound-row provider fields, and the activity label
 * differ. Centralising those here keeps a single orchestrator instead of one
 * near-duplicate per channel.
 */
interface ChannelTransport {
  /** Subcollection under contacts/{id} where this channel's thread lives. */
  messagesCollection: string;
  /** When set, only thread rows whose `channel` field matches count as
   *  history (metaMessages mixes messenger + instagram in one collection). */
  historyChannelFilter?: string;
  /** Human label used in activity-log lines ("SMS" / "Instagram" / …). */
  label: string;
  /** Per-channel opt-out flag check. */
  isOptedOut: (contact: Contact) => boolean;
  /** Send the reply; returns the provider message id + the from address. */
  send: (args: {
    subAccountId: string;
    subAccount: SubAccountDoc;
    to: string;
    body: string;
    /** Needed by rails that resolve the service window per contact. */
    contactId: string;
  }) => Promise<{ sid: string; from: string }>;
  /** Provider-specific fields for the outbound thread row (message-id field
   *  naming + channel discriminator differ between Twilio and Meta rows). */
  outboundRowExtras: (sid: string) => Record<string, unknown>;
}

function getChannelTransport(
  channelId: ConfiguredChannelId,
  metaChannel?: "messenger" | "instagram",
  inboundProvider?: WhatsAppProviderId,
): ChannelTransport {
  if (channelId === "whatsapp") {
    // Routed through the provider dispatcher, not Twilio directly, so a
    // workspace on the Meta Cloud rail still gets AI replies. Calling the
    // Twilio helper here would throw "WhatsApp is not configured" for a
    // correctly-configured Cloud workspace, and the orchestrator swallows
    // send errors — so the bot would simply go mute with nothing to see.
    //
    // The window is passed as "open": this orchestrator only ever fires in
    // response to a just-received inbound, so a re-read could only race the
    // webhook's own message write and wrongly report the window shut.
    return {
      messagesCollection: "whatsappMessages",
      label: "WhatsApp",
      isOptedOut: (c) => c.whatsappOptedOut === true,
      send: ({ subAccountId, subAccount, to, body, contactId }) =>
        sendWhatsappFreeFormForSubAccount({
          subAccountId,
          subAccount,
          contactId,
          to,
          body,
          lastInboundAt: new Date(),
          senderId: inboundProvider
            ? whatsappSenderIdOnRail(subAccount, inboundProvider)
            : null,
        }),
      outboundRowExtras: (sid) => ({ twilioMessageSid: sid }),
    };
  }
  if (channelId === "sms") {
    return {
      messagesCollection: "messages",
      label: "SMS",
      isOptedOut: (c) => smsSendBlock(c) !== null,
      send: ({ subAccountId, subAccount, to, body }) =>
        sendSmsForSubAccount({ subAccountId, subAccount, to, body }).then(
          (r) => ({ sid: r.sid, from: r.from }),
        ),
      outboundRowExtras: (sid) => ({ twilioMessageSid: sid }),
    };
  }
  if (channelId === "meta") {
    // Messenger/Instagram DM over the Graph API. `platform` decides the send
    // channel + labels; the caller (Meta inbound webhook) always sets it to
    // the platform the DM arrived on. No session-window guard needed — this
    // orchestrator only fires on a just-received inbound, so Meta's 24h
    // window is open by definition (same reasoning as WhatsApp above). No
    // opt-out flag either: Meta has no STOP semantics — a user who doesn't
    // want replies blocks the Page/profile on-platform, and Meta then
    // rejects the send.
    const platform = metaChannel ?? "messenger";
    return {
      messagesCollection: "metaMessages",
      historyChannelFilter: platform,
      label: platform === "instagram" ? "Instagram" : "Messenger",
      isOptedOut: () => false,
      send: async ({ subAccountId, subAccount, to, body }) => {
        const cfg = subAccount.metaConfig;
        const pageAccessToken = cfg?.connected
          ? await readSubAccountSecret(subAccountId, "meta", cfg)
          : "";
        if (!cfg?.connected || !pageAccessToken || !cfg.pageId) {
          throw new Error("No connected Meta Page for this sub-account.");
        }
        const messageId = await sendMetaMessage({
          channel: platform,
          fromNodeId: cfg.pageId,
          recipientId: to,
          text: body,
          pageAccessToken,
        });
        return { sid: messageId, from: cfg.pageId };
      },
      outboundRowExtras: (sid) => ({ channel: platform, metaMessageId: sid }),
    };
  }
  // web-chat + voice have dedicated orchestrators; they never reach here.
  throw new Error(
    `maybeRespondWithAi does not support channel "${channelId}".`,
  );
}

/**
 * Decides whether the current local time (in the configured timezone)
 * falls within the agent's active window. Supports overnight windows
 * (e.g. hoursStart=22, hoursEnd=6 = 10pm to 6am).
 */
// Shared implementation — see lib/comms/business-hours.ts. Local alias
// keeps the existing call sites unchanged.
const isWithinHours = isWithinBusinessHours;

async function loadRecentHistory(
  contactId: string,
  limit: number,
  excludeBody: string,
  messagesCollection: string,
  channelFilter?: string,
): Promise<AiChatMessage[]> {
  const safeLimit = Math.max(1, Math.min(50, limit));
  // With a channel filter (metaMessages mixes messenger + instagram rows in
  // one collection), over-fetch so in-code filtering still yields ~limit
  // turns. In-code beats a where() here — no composite index needed.
  const fetchLimit = channelFilter
    ? Math.min(50, safeLimit * 2 + 1)
    : safeLimit + 1;
  const snap = await getAdminDb()
    .collection("contacts")
    .doc(contactId)
    .collection(messagesCollection)
    .orderBy("createdAt", "desc")
    .limit(fetchLimit)
    .get();
  const docs = snap.docs.reverse();
  const turns: AiChatMessage[] = [];
  for (const d of docs) {
    const data = d.data() as {
      direction?: string;
      body?: string;
      channel?: string;
    };
    if (!data.body) continue;
    if (channelFilter && data.channel !== channelFilter) continue;
    if (data.direction === "inbound" && data.body.trim() === excludeBody.trim()) {
      continue;
    }
    turns.push({
      role: data.direction === "outbound" ? "assistant" : "user",
      content: data.body,
    });
  }
  return turns;
}

// System prompt building moved to @/lib/comms/ai/prompt — shared with the
// web-chat orchestrator and the "Test this persona" dry-run endpoint so
// every channel sees the same string the SMS path produces.

async function logActivity({
  contactId,
  agencyId,
  subAccountId,
  type,
  content,
  meta,
}: {
  contactId: string;
  agencyId: string;
  subAccountId: string;
  type: "ai_reply_sent" | "ai_escalated" | "ai_skipped";
  content: string;
  meta?: Record<string, unknown>;
}): Promise<void> {
  try {
    await getAdminDb()
      .collection("contacts")
      .doc(contactId)
      .collection("activities")
      .add({
        type,
        content,
        meta: meta ?? null,
        agencyId,
        subAccountId,
        createdBy: "ai_inbound",
        createdAt: FieldValue.serverTimestamp(),
      });
  } catch (err) {
    console.warn("[ai/respond] activity write failed", err);
  }
}

async function storeOutboundReply({
  contactId,
  agencyId,
  subAccountId,
  body,
  from,
  to,
  providerSid,
  messagesCollection,
  extras,
}: {
  contactId: string;
  agencyId: string;
  subAccountId: string;
  body: string;
  from: string;
  to: string;
  /** Provider message id — also the doc id (natural retry-dedupe). */
  providerSid: string;
  messagesCollection: string;
  /** Provider-specific row fields from the transport (e.g.
   *  `twilioMessageSid` for Twilio, `channel` + `metaMessageId` for Meta). */
  extras: Record<string, unknown>;
}): Promise<void> {
  try {
    await getAdminDb()
      .collection("contacts")
      .doc(contactId)
      .collection(messagesCollection)
      .doc(providerSid)
      .set(
        {
          agencyId,
          subAccountId,
          contactId,
          direction: "outbound",
          status: "sent",
          body,
          from,
          to,
          ...extras,
          sentByUid: "ai",
          aiGenerated: true,
          error: null,
          readAt: null,
          createdAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
  } catch (err) {
    console.warn("[ai/respond] outbound message write failed", err);
  }
}

const LOOP_LABEL: Record<AiLoopReason, string> = {
  repeated_text:
    "the contact sent the same long message several times in a row (likely an auto-reply)",
  volume_cap: "too many AI replies on this conversation in 10 minutes",
};

/**
 * Main orchestrator. Webhook caller already resolved profile + channel
 * into a ResolvedAiAgent via resolveAgent() — this function just
 * orchestrates the guards → context → LLM → send → log flow.
 */
export async function maybeRespondWithAi(
  input: RespondInput,
): Promise<RespondOutcome> {
  const {
    subAccountId,
    subAccount,
    agent,
    channelId,
    contact,
    incomingMessage,
    replyTo,
    metaChannel,
    inboundProvider,
  } = input;
  const eff = agent.effective;
  const transport = getChannelTransport(channelId, metaChannel, inboundProvider);
  // The conversation/draft channel mirrors the platform for Meta DMs
  // ("messenger" | "instagram"); for Twilio channels it IS the channel id.
  const conversationChannel = (metaChannel ?? channelId) as ConversationChannel;

  // Guard: contact is opted out of this channel.
  if (transport.isOptedOut(contact)) {
    await logActivity({
      contactId: contact.id,
      agencyId: subAccount.agencyId,
      subAccountId,
      type: "ai_skipped",
      content: `AI reply skipped — contact is ${transport.label}-opted-out.`,
      meta: { reason: "contact_opted_out", channel: channelId },
    });
    return { kind: "skipped", reason: "contact_opted_out" };
  }

  // Guard: profile prompt blank — refuse to send anything.
  if (!eff.systemPrompt.trim()) {
    await logActivity({
      contactId: contact.id,
      agencyId: subAccount.agencyId,
      subAccountId,
      type: "ai_skipped",
      content: "AI reply skipped — agent persona prompt is empty.",
      meta: { reason: "no_prompt" },
    });
    return { kind: "skipped", reason: "no_prompt" };
  }

  // Guard: outside configured business hours.
  if (!isWithinHours(eff.hoursStart, eff.hoursEnd, eff.timezone)) {
    await logActivity({
      contactId: contact.id,
      agencyId: subAccount.agencyId,
      subAccountId,
      type: "ai_skipped",
      content: `AI reply skipped — outside business hours (${eff.hoursStart}:00–${eff.hoursEnd}:00 ${eff.timezone}).`,
      meta: { reason: "outside_hours" },
    });
    return { kind: "skipped", reason: "outside_hours" };
  }

  // Guard: monthly AI-token quota (Usage Metering v1). Checked BEFORE the
  // LLM call so an over-cap workspace spends nothing. Fails open.
  const tokenQuota = await checkQuota({
    subAccountId,
    unit: "aiTokens",
    subAccount,
  });
  if (!tokenQuota.allowed) {
    await logActivity({
      contactId: contact.id,
      agencyId: subAccount.agencyId,
      subAccountId,
      type: "ai_skipped",
      content: "AI reply skipped — monthly AI usage limit reached.",
      meta: { reason: "quota" },
    });
    return { kind: "skipped", reason: "quota" };
  }

  // Guard: escalation keyword in the inbound text.
  const triggered = matchEscalationKeyword(
    incomingMessage,
    eff.escalationKeywords,
  );
  if (triggered) {
    if (eff.escalationNotifyEmail) {
      const appUrl =
        process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://leadstack.dev";
      await sendEscalationNotification({
        to: eff.escalationNotifyEmail,
        businessName:
          eff.businessName.trim() || subAccount.name || "your business",
        contactName: contact.name || "(unnamed)",
        // Meta contacts often have no phone — the platform label beats a
        // raw Meta-scoped id in the notification email.
        contactPhone:
          contact.phone?.trim() ||
          (metaChannel ? `(via ${transport.label})` : replyTo),
        contactId: contact.id,
        subAccountId,
        triggeredKeyword: triggered,
        incomingMessage,
        appUrl,
      });
    }
    await logActivity({
      contactId: contact.id,
      agencyId: subAccount.agencyId,
      subAccountId,
      type: "ai_escalated",
      content: `AI escalated to human — keyword "${triggered}" matched in inbound message.`,
      meta: { reason: "escalation_keyword", keyword: triggered, channel: channelId },
    });
    return { kind: "escalated", keyword: triggered };
  }

  // Per-conversation AI controls (unified inbox). Layered ON TOP of the
  // channel-level `enabled` gate the webhook already checked. Pause wins over
  // mode. Defaults to auto/not-paused for legacy conversations.
  const controls = await getConversationControls(contact.id);
  if (controls.botPausedUntilMs && controls.botPausedUntilMs > Date.now()) {
    await logActivity({
      contactId: contact.id,
      agencyId: subAccount.agencyId,
      subAccountId,
      type: "ai_skipped",
      content: "AI reply skipped — bot paused after a human took over.",
      meta: { reason: "bot_paused", channel: channelId },
    });
    return { kind: "skipped", reason: "bot_paused" };
  }
  if (controls.botMode === "off") {
    await logActivity({
      contactId: contact.id,
      agencyId: subAccount.agencyId,
      subAccountId,
      type: "ai_skipped",
      content: "AI reply skipped — bot turned off for this conversation.",
      meta: { reason: "bot_off", channel: channelId },
    });
    return { kind: "skipped", reason: "bot_off" };
  }
  const suggestOnly = controls.botMode === "suggest";

  // Guard: bot-to-bot reply loop (see loop-guard.ts). Before the LLM call, so
  // a tripped loop spends nothing. Suggest mode sends nothing, so cannot loop.
  const loop = suggestOnly
    ? null
    : await detectAiReplyLoop({
        contactId: contact.id,
        messagesCollection: transport.messagesCollection,
        resetAtMs: controls.loopResetAtMs,
      });
  if (loop) {
    const { paused, turnedOff } = await pauseBotForReplyLoop(contact.id);
    if (eff.escalationNotifyEmail) {
      await sendReplyLoopNotification({
        to: eff.escalationNotifyEmail,
        subAccountId,
        subAccount,
        contactId: contact.id,
        contactName: contact.name ?? "",
        paused,
        turnedOff,
        appUrl:
          process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://leadstack.dev",
      });
    }
    const loopOutcome = turnedOff
      ? "This is the second loop within 24 hours; the bot is now turned OFF for this conversation until a human turns it back on."
      : paused
        ? "Bot paused on this conversation for 1 hour; a human needs to pick it up."
        : "Pausing the bot FAILED — it is not paused; a human needs to pick this up.";
    await logActivity({
      contactId: contact.id,
      agencyId: subAccount.agencyId,
      subAccountId,
      type: "ai_skipped",
      content: `AI reply stopped — ${LOOP_LABEL[loop]}. ${loopOutcome}`,
      meta: { reason: "reply_loop", loop, paused, turnedOff, channel: channelId },
    });
    return { kind: "skipped", reason: "reply_loop" };
  }

  // Build LLM context and call the model.
  let completion;
  try {
    const [history, contextBlock] = await Promise.all([
      loadRecentHistory(
        contact.id,
        eff.contextMessageCount,
        incomingMessage,
        transport.messagesCollection,
        transport.historyChannelFilter,
      ),
      buildContactContextBlock(contact).catch((err) => {
        console.warn(
          `[ai/respond] context block build failed for ${contact.id}`,
          err,
        );
        return null;
      }),
    ]);
    const systemPrompt = buildSystemPrompt({
      agent,
      channelId,
      fallbackBusinessName: subAccount.name ?? "the business",
      contactContextBlock: contextBlock,
      bookingLink: subAccount.bookingLink ?? null,
    });
    const messages: AiChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: incomingMessage },
    ];
    completion = await callAi({
      model: eff.modelOverride ?? undefined,
      messages,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(`[ai/respond] LLM call failed for sa=${subAccountId}: ${msg}`);
    await logActivity({
      contactId: contact.id,
      agencyId: subAccount.agencyId,
      subAccountId,
      type: "ai_skipped",
      content: `AI reply skipped — LLM call failed: ${msg.slice(0, 200)}`,
      meta: { reason: "llm_failed", error: msg.slice(0, 500) },
    });
    return { kind: "skipped", reason: "llm_failed" };
  }

  // Suggest mode: stash the generated reply for a human to approve/edit in the
  // inbox instead of sending it. Tokens were spent, so still count them.
  if (suggestOnly) {
    await setConversationDraft({
      contactId: contact.id,
      subAccountId,
      agencyId: subAccount.agencyId,
      contactName: contact.name ?? "",
      contactPhone: contact.phone ?? (metaChannel ? "" : replyTo),
      channel: conversationChannel,
      body: completion.text,
      model: completion.model,
      tokens: completion.totalTokens,
    });
    void incrementChannelTokens(subAccountId, channelId, completion.totalTokens);
    return {
      kind: "drafted",
      replyText: completion.text,
      tokens: completion.totalTokens,
    };
  }

  // Send the reply via the channel transport (Twilio or the Meta Graph API).
  let send;
  try {
    send = await transport.send({
      subAccountId,
      subAccount,
      to: replyTo,
      body: completion.text,
      contactId: contact.id,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(
      `[ai/respond] ${transport.label} send failed for sa=${subAccountId}: ${msg}`,
    );
    await logActivity({
      contactId: contact.id,
      agencyId: subAccount.agencyId,
      subAccountId,
      type: "ai_skipped",
      content: `AI reply generated but ${transport.label} send failed: ${msg.slice(0, 200)}`,
      meta: { reason: "llm_failed", sendError: msg.slice(0, 500), channel: channelId },
    });
    return { kind: "skipped", reason: "llm_failed" };
  }

  await storeOutboundReply({
    contactId: contact.id,
    agencyId: subAccount.agencyId,
    subAccountId,
    body: completion.text,
    from: send.from,
    to: replyTo,
    providerSid: send.sid,
    messagesCollection: transport.messagesCollection,
    extras: transport.outboundRowExtras(send.sid),
  });

  // Unified-inbox index — reflect the bot's reply as the conversation's
  // latest message.
  await upsertConversationForMessage({
    contactId: contact.id,
    subAccountId,
    agencyId: subAccount.agencyId,
    contactName: contact.name ?? "",
    contactPhone: contact.phone ?? (metaChannel ? null : replyTo),
    channel: conversationChannel,
    direction: "outbound",
    body: completion.text,
  });

  await logActivity({
    contactId: contact.id,
    agencyId: subAccount.agencyId,
    subAccountId,
    type: "ai_reply_sent",
    content: `AI replied via ${transport.label} (${completion.totalTokens} tokens, ${completion.model}).`,
    meta: {
      channel: channelId,
      model: completion.model,
      tokens: completion.totalTokens,
      promptTokens: completion.promptTokens,
      completionTokens: completion.completionTokens,
      providerSid: send.sid,
    },
  });

  void incrementChannelTokens(subAccountId, channelId, completion.totalTokens);

  return {
    kind: "replied",
    replyText: completion.text,
    tokens: completion.totalTokens,
  };
}
