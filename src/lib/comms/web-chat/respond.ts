import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { callAi, type AiChatMessage } from "@/lib/comms/ai/openrouter";
import { replyModelFallback } from "@/lib/comms/ai/model-policy";
import {
  incrementChannelTokens,
  resolveAgent,
} from "@/lib/comms/ai/agent";
import { buildContactContextBlock } from "@/lib/comms/ai/context";
import { buildSystemPrompt } from "@/lib/comms/ai/prompt";
import { isWithinBusinessHours } from "@/lib/comms/business-hours";
import { checkQuota } from "@/lib/server/usage-meter";
import {
  matchEscalationKeyword,
  sendEscalationNotification,
} from "@/lib/comms/ai/escalation";
import {
  appendMessage,
  getOrCreateSession,
  loadRecentHistory,
  markCapturePromptShown,
} from "@/lib/comms/web-chat/session";
import {
  parseCaptureMarker,
  parseFormMarker,
  reconcileContactFromCapture,
  type CaptureFieldId,
} from "@/lib/comms/web-chat/capture";
import {
  getConversationControls,
  setConversationDraft,
  upsertConversationForMessage,
} from "@/lib/server/conversations-service";
import { writeInboundMessageActivity } from "@/lib/server/contact-activities";
import { webChatConversationId } from "@/types/conversations";
import type { SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";
import type { WebChatSession } from "@/types/web-chat";
import { runAfterResponse } from "@/lib/server/after-response";

/**
 * Web-chat reply orchestrator. Mirrors `maybeRespondWithAi` for SMS but
 * with web-chat-specific bits:
 *
 *   - Returns the reply text instead of sending via Twilio (caller hands
 *     it back to the widget as the HTTP response body).
 *   - Persists messages to `webChatSessions/{id}/messages/*` not to a
 *     contact's chat thread.
 *   - Anonymous-first: skips the contact-context block until the session
 *     has been linked via the [[capture …]] marker — and for good when it
 *     was linked to a pre-existing contact on an unverified claim.
 *   - Strips the [[capture …]] marker before storing or returning the
 *     reply, then runs contact reconciliation.
 *
 * Guards short-circuit with a structured outcome so the widget can show
 * a friendly fallback ("our team will reply soon") instead of an LLM
 * reply. The outcome is also written into the message log for debugging.
 */

export type WebChatSkipReason =
  | "agent_not_configured"
  | "channel_disabled"
  | "no_prompt"
  | "outside_hours"
  | "escalation_keyword"
  | "llm_failed"
  // A human is handling this thread from the unified inbox — either the
  // per-conversation AI mode is "off", or a human reply paused the bot.
  | "human_takeover"
  // AI mode is "suggest": the bot drafted a reply for operator approval
  // instead of sending it to the visitor.
  | "suggest_draft"
  // Monthly AI usage quota reached (Usage Metering v1) — no LLM call.
  | "quota";

export type WebChatOutcome =
  | {
      kind: "replied";
      replyText: string;
      tokens: number;
      contactId: string | null;
      /** When set, the widget renders an inline form below this reply
       *  for the visitor to fill in. Null on replies that don't request
       *  contact capture (most replies). */
      formFields: CaptureFieldId[] | null;
    }
  | { kind: "escalated"; keyword: string; fallbackReply: string }
  | { kind: "skipped"; reason: WebChatSkipReason; fallbackReply: string };

export interface RespondToWebChatInput {
  subAccountId: string;
  agencyId: string;
  /** Stable visitor session id (UUID generated client-side, stored in
   *  the visitor's localStorage). Created lazily on first message. */
  sessionId: string;
  /** Just-arrived inbound message from the visitor. */
  incomingMessage: string;
  /** Best-effort visitor metadata used when seeding the session. Safe
   *  to pass null fields — they get null-coalesced into the doc. */
  pageUrl: string | null;
  referrer: string | null;
  origin: string | null;
  visitorIp: string | null;
  visitorUserAgent: string | null;
}

/** Polite generic reply used when the bot can't / won't answer. Visible
 *  to the visitor so it must be neutral and brand-safe. */
const FALLBACK_REPLY =
  "Thanks for reaching out! I'll have someone from the team get back to you shortly.";

/**
 * Outside-hours reply. Deliberately NOT the generic fallback: on this path
 * the LLM never runs, so the [[form]] capture marker can never fire and no
 * contact exists — promising "someone will get back to you shortly" was a
 * promise nothing could keep. This message is honest: the transcript IS
 * stored and visible in the operator's Sessions console, so "your message
 * has been saved" is true even for an anonymous visitor.
 */
const OUT_OF_HOURS_REPLY =
  "Thanks for your message! We're currently closed, but your message has been saved — check back during business hours and we'll pick things up from here.";

/**
 * "Held" states — a human has the thread (AI off, paused, or suggest-mode).
 * The bot stays SILENT: no reply text, nothing written to the transcript, and
 * the widget shows NO note on send. `offline` (true only when a held message
 * lands outside the configured hours) tells the widget to surface a "we're
 * offline" line straight away; within hours it stays quiet and arms its own
 * short timer for a softer "we'll follow up" note. `heldResult` returns
 * without appending an outbound row, so repeated visitor messages don't
 * generate repeated holding lines, and the widget polls for the operator's
 * real reply.
 */
function heldResult(
  session: WebChatSession,
  reason: WebChatSkipReason,
  offline: boolean,
): {
  session: WebChatSession;
  outcome: WebChatOutcome;
  outboundMessageId: string;
  offline: boolean;
} {
  return {
    session,
    outcome: { kind: "skipped", reason, fallbackReply: "" },
    outboundMessageId: "",
    offline,
  };
}

/** Build the anonymous visitor's display label from the page they're on.
 *  Exported so the capture route stamps the same label on the inbox row. */
export function webChatVisitorLabel(
  pageUrl: string | null,
  referrer: string | null = null,
): string {
  const raw = pageUrl ?? referrer ?? null;
  if (!raw) return "Web visitor";
  try {
    const u = new URL(raw);
    const path = u.pathname && u.pathname !== "/" ? u.pathname : u.hostname;
    return `Web visitor · ${path}`.slice(0, 80);
  } catch {
    return "Web visitor";
  }
}

function buildVisitorLabel(session: WebChatSession): string {
  return webChatVisitorLabel(session.pageUrl ?? null, session.referrer ?? null);
}

/** Denormalized name for the inbox row: captured name → "Web lead" once a
 *  contact exists → the anonymous visitor label otherwise. */
function displayNameFor(
  session: WebChatSession,
  contactId: string | null,
  label: string,
): string {
  if (session.capturedName?.trim()) return session.capturedName.trim();
  return contactId ? "Web lead" : label;
}

// Shared implementation — see lib/comms/business-hours.ts. Local alias
// keeps the existing call sites unchanged.
const isWithinHours = isWithinBusinessHours;

export async function respondToWebChat(
  input: RespondToWebChatInput,
): Promise<{
  session: WebChatSession;
  outcome: WebChatOutcome;
  /** Firestore id of the outbound (reply / holding) message just written —
   *  the widget adds it to its seen-set so the poll won't double-render it. */
  outboundMessageId: string;
  /** Only meaningful on a held ("human_takeover") outcome: true when the
   *  message landed outside the configured hours, so the widget can say
   *  "we're offline" immediately instead of arming its wait timer. */
  offline?: boolean;
}> {
  const db = getAdminDb();

  // Always get-or-create the session first so even rejected messages
  // have a thread to log against.
  const session = await getOrCreateSession({
    subAccountId: input.subAccountId,
    agencyId: input.agencyId,
    sessionId: input.sessionId,
    pageUrl: input.pageUrl,
    referrer: input.referrer,
    origin: input.origin,
    visitorIp: input.visitorIp,
    visitorUserAgent: input.visitorUserAgent,
  });

  // Persist the inbound regardless of outcome. The bot's reply (or
  // fallback) is appended at the bottom of this function.
  const inboundMessageId = await appendMessage({
    subAccountId: input.subAccountId,
    agencyId: input.agencyId,
    sessionId: input.sessionId,
    direction: "inbound",
    body: input.incomingMessage,
    tokens: null,
    aiGenerated: false,
  });
  // Once the visitor is a contact, their chat is part of that record.
  if (session.contactId) {
    await writeInboundMessageActivity(getAdminDb(), {
      contactId: session.contactId,
      channel: "webchat",
      preview: input.incomingMessage,
      messageId: inboundMessageId,
      agencyId: input.agencyId,
      subAccountId: input.subAccountId,
    });
  }

  // Surface this thread in the unified inbox (session-keyed so anonymous
  // visitors appear live). Best-effort — the upsert swallows its own errors.
  const visitorLabel = buildVisitorLabel(session);
  await upsertConversationForMessage({
    contactId: session.contactId,
    conversationKey: webChatConversationId(input.sessionId),
    sessionId: input.sessionId,
    visitorLabel,
    subAccountId: input.subAccountId,
    agencyId: input.agencyId,
    contactName: displayNameFor(session, session.contactId, visitorLabel),
    contactPhone: session.capturedPhone ?? null,
    channel: "web-chat",
    direction: "inbound",
    body: input.incomingMessage,
  });

  // Per-conversation AI controls (auto / suggest / off + human-takeover
  // pause) — read once, applied below. Missing doc → auto + not-paused, so a
  // pre-existing session keeps auto-replying exactly as before.
  const controls = await getConversationControls(
    webChatConversationId(input.sessionId),
  );
  const botPaused =
    controls.botPausedUntilMs !== null &&
    controls.botPausedUntilMs > Date.now();

  const agent = await resolveAgent(input.subAccountId, "web-chat");
  if (!agent) {
    return finalize(input, session, {
      kind: "skipped",
      reason: "agent_not_configured",
      fallbackReply: FALLBACK_REPLY,
    });
  }
  const eff = agent.effective;

  if (!eff.enabled) {
    return finalize(input, session, {
      kind: "skipped",
      reason: "channel_disabled",
      fallbackReply: FALLBACK_REPLY,
    });
  }
  if (!eff.systemPrompt.trim()) {
    return finalize(input, session, {
      kind: "skipped",
      reason: "no_prompt",
      fallbackReply: FALLBACK_REPLY,
    });
  }

  // Human-in-control gate. When the operator set this thread's AI mode to
  // "off", or a human reply paused the bot, the AI stays fully silent — no
  // LLM spend, no escalation, and crucially NO reply written (so the visitor
  // isn't auto-answered on every message). The widget shows a one-time note
  // and polls for the human's reply. Default mode is "auto" (+ not paused),
  // so this is inert for normal auto-reply sessions.
  if (controls.botMode === "off" || botPaused) {
    // A human owns this thread. Tell the widget whether we're currently
    // outside the configured hours so it can say "we're offline" right away
    // (vs. staying quiet + arming its own "still waiting" timer within hours).
    const offline = !isWithinHours(eff.hoursStart, eff.hoursEnd, eff.timezone);
    return heldResult(session, "human_takeover", offline);
  }

  if (!isWithinHours(eff.hoursStart, eff.hoursEnd, eff.timezone)) {
    return finalize(input, session, {
      kind: "skipped",
      reason: "outside_hours",
      fallbackReply: OUT_OF_HOURS_REPLY,
    });
  }

  // Monthly AI-token quota (Usage Metering v1) — checked BEFORE the LLM
  // call so an over-cap workspace spends nothing. Fails open. The generic
  // fallback is honest here: the transcript lands in the operator's
  // Sessions console, so a human genuinely can pick it up.
  const tokenQuota = await checkQuota({
    subAccountId: input.subAccountId,
    unit: "aiTokens",
  });
  if (!tokenQuota.allowed) {
    return finalize(input, session, {
      kind: "skipped",
      reason: "quota",
      fallbackReply: FALLBACK_REPLY,
    });
  }

  const triggered = matchEscalationKeyword(
    input.incomingMessage,
    eff.escalationKeywords,
  );
  if (triggered) {
    // Best-effort notify; never fail the visitor's response on email errors.
    if (eff.escalationNotifyEmail) {
      const saSnap = await db.doc(`subAccounts/${input.subAccountId}`).get();
      const subAccount = saSnap.data() as SubAccountDoc | undefined;
      const appUrl =
        process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://leadstack.dev";
      const to = eff.escalationNotifyEmail;
      runAfterResponse(() => sendEscalationNotification({
        to,
        businessName:
          eff.businessName.trim() || subAccount?.name || "your business",
        contactName: session.capturedName ?? "(anonymous web visitor)",
        contactPhone: session.capturedPhone ?? "—",
        contactId: session.contactId ?? input.sessionId,
        subAccountId: input.subAccountId,
        triggeredKeyword: triggered,
        incomingMessage: input.incomingMessage,
        appUrl,
      }).catch((err) => {
        console.warn(
          `[web-chat/respond] escalation email failed sa=${input.subAccountId}`,
          err,
        );
      }));
    }
    return finalize(input, session, {
      kind: "escalated",
      keyword: triggered,
      fallbackReply: FALLBACK_REPLY,
    });
  }

  // Load identified-contact context only for a contact this session created
  // from the visitor's own details. A session linked to a PRE-EXISTING
  // contact got there on an unverified claimed email/phone — handing the bot
  // that contact's deals would read them back to whoever typed the email.
  let contextBlock: string | null = null;
  if (session.contactId && session.contactCreatedBySession === true) {
    try {
      const contactSnap = await db
        .collection("contacts")
        .doc(session.contactId)
        .get();
      if (contactSnap.exists) {
        const contact = {
          id: contactSnap.id,
          ...(contactSnap.data() as Omit<Contact, "id">),
        };
        contextBlock = await buildContactContextBlock(contact);
      }
    } catch (err) {
      console.warn(
        `[web-chat/respond] contact context build failed for ${session.contactId}`,
        err,
      );
    }
  }

  // Read history AFTER appending the inbound above — pass excludeBody so
  // we don't double-feed the just-arrived turn.
  const history = await loadRecentHistory(
    input.subAccountId,
    input.sessionId,
    eff.contextMessageCount,
    input.incomingMessage,
  );

  const saSnap = await db.doc(`subAccounts/${input.subAccountId}`).get();
  const subAccount = saSnap.data() as SubAccountDoc | undefined;

  let systemPrompt = buildSystemPrompt({
    agent,
    channelId: "web-chat",
    fallbackBusinessName: subAccount?.name ?? "the business",
    contactContextBlock: contextBlock,
    bookingLink: subAccount?.bookingLink ?? null,
  });

  // Tack a session-state hint onto the prompt when capture is already
  // done or skipped. Stops the bot pestering the visitor on follow-up
  // turns even if it forgets the "AT MOST ONCE" rule from safety rails.
  if (session.contactId) {
    systemPrompt += `\n\n--- SESSION STATE ---\nContact details for this visitor have already been captured. Do NOT emit a [[form]] or [[capture]] marker. Continue the conversation normally; the team will follow up.`;
  } else if (session.capturePromptShownAt) {
    systemPrompt += `\n\n--- SESSION STATE ---\nA capture form has already been shown to this visitor${session.captureSkipped ? " and they skipped it" : ""}. Do NOT emit another [[form]] or [[capture]] marker on this session.`;
  }

  const messages: AiChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...history,
    { role: "user", content: input.incomingMessage },
  ];

  let completion;
  try {
    completion = await callAi({
      model: eff.modelOverride ?? undefined,
      messages,
      ...replyModelFallback(input.subAccountId, "web-chat"),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error(
      `[web-chat/respond] LLM call failed sa=${input.subAccountId}: ${msg}`,
    );
    return finalize(input, session, {
      kind: "skipped",
      reason: "llm_failed",
      fallbackReply: FALLBACK_REPLY,
    });
  }

  // Run BOTH parsers — bot may have emitted form OR capture (instructed
  // to pick one; we tolerate either order if it ignores the instruction).
  const afterForm = parseFormMarker(completion.text);
  const afterCapture = parseCaptureMarker(afterForm.cleanText);
  const cleanText = afterCapture.cleanText;
  const capture = afterCapture.capture;

  // Suppress the form request if it was already shown this session, or
  // the visitor has already been linked to a contact. Belt-and-braces
  // since the prompt also tells the bot not to repeat — but bots drift.
  const formAlreadyHandled =
    !!session.contactId || !!session.capturePromptShownAt;
  const formFields = formAlreadyHandled ? null : afterForm.fields;

  let contactId = session.contactId;

  // Free-text capture marker — bot extracted volunteered details.
  if (capture) {
    try {
      const reconciled = await reconcileContactFromCapture({
        agencyId: input.agencyId,
        subAccountId: input.subAccountId,
        sessionId: input.sessionId,
        existingContactId: session.contactId,
        pageUrl: input.pageUrl,
        capture,
      });
      if (reconciled) contactId = reconciled.contactId;
    } catch (err) {
      console.warn(
        `[web-chat/respond] capture reconcile failed sa=${input.subAccountId}`,
        err,
      );
    }
  }

  // If we're going to render an inline form, stamp the session so the
  // next turn won't ask again even if the bot tries.
  if (formFields) {
    runAfterResponse(() => markCapturePromptShown({
      subAccountId: input.subAccountId,
      sessionId: input.sessionId,
    }).catch(() => {}));
  }

  runAfterResponse(() => incrementChannelTokens(
    input.subAccountId,
    "web-chat",
    completion.totalTokens,
  ));

  // Suggest mode: don't reply to the visitor. Park the drafted reply on the
  // conversation for an operator to approve/edit + send from the inbox, and
  // give the visitor a holding line (the widget polls for the human's send).
  if (controls.botMode === "suggest") {
    runAfterResponse(() => setConversationDraft({
      contactId: contactId ?? null,
      conversationKey: webChatConversationId(input.sessionId),
      sessionId: input.sessionId,
      visitorLabel,
      subAccountId: input.subAccountId,
      agencyId: input.agencyId,
      contactName: displayNameFor(session, contactId, visitorLabel),
      contactPhone: session.capturedPhone ?? null,
      channel: "web-chat",
      body: cleanText,
      model: completion.model,
      tokens: completion.totalTokens,
    }));
    // Stay silent to the visitor — the drafted reply waits for operator
    // approval; the approved send reaches the widget via the poll. Suggest
    // mode only runs after the within-hours gate above passed, so it's never
    // "offline".
    return heldResult(session, "suggest_draft", false);
  }

  return finalize(input, session, {
    kind: "replied",
    replyText: cleanText,
    tokens: completion.totalTokens,
    contactId: contactId ?? null,
    formFields,
  });
}

/**
 * Persist the outbound reply (or fallback) + return the structured
 * outcome. Centralized so every code path writes the same shape.
 */
async function finalize(
  input: RespondToWebChatInput,
  session: WebChatSession,
  outcome: WebChatOutcome,
): Promise<{
  session: WebChatSession;
  outcome: WebChatOutcome;
  outboundMessageId: string;
}> {
  const body =
    outcome.kind === "replied" ? outcome.replyText : outcome.kind === "escalated"
      ? outcome.fallbackReply
      : outcome.fallbackReply;
  const tokens = outcome.kind === "replied" ? outcome.tokens : null;
  const aiGenerated = outcome.kind === "replied";

  const outboundMessageId = await appendMessage({
    subAccountId: input.subAccountId,
    agencyId: input.agencyId,
    sessionId: input.sessionId,
    direction: "outbound",
    body,
    tokens,
    aiGenerated,
  });

  // Reflect the outbound (bot reply / holding line) in the unified inbox.
  // pauseBot stays false — this is the bot/system speaking, not a human, so
  // it must not pause the AI or clear the operator's unread badge. (A human's
  // reply goes through /api/comms/web-chat/send, which passes pauseBot.)
  const finalContactId =
    outcome.kind === "replied" ? outcome.contactId : session.contactId;
  const label = buildVisitorLabel(session);
  await upsertConversationForMessage({
    contactId: finalContactId,
    conversationKey: webChatConversationId(input.sessionId),
    sessionId: input.sessionId,
    visitorLabel: label,
    subAccountId: input.subAccountId,
    agencyId: input.agencyId,
    contactName: displayNameFor(session, finalContactId, label),
    contactPhone: session.capturedPhone ?? null,
    channel: "web-chat",
    direction: "outbound",
    body,
  });

  // If we escalated or skipped, mark the session.
  if (outcome.kind === "escalated") {
    await getAdminDb()
      .doc(
        `subAccounts/${input.subAccountId}/webChatSessions/${input.sessionId}`,
      )
      .update({
        status: "escalated",
        updatedAt: FieldValue.serverTimestamp(),
      });
  }

  return { session, outcome, outboundMessageId };
}
