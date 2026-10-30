import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { emailIsConfigured, sendEmail, tenantFrom } from "@/lib/comms/resend";
import { sendPushForEvent } from "@/lib/push/send";
import { contactTerritoryId } from "@/lib/push/events";
import type { SubAccountDoc } from "@/types";

/**
 * Bot-to-bot reply-loop guard.
 *
 * A customer's own auto-responder (WhatsApp Business away message, an SMS
 * autoresponder) answers every AI reply, and the AI answers it back — until
 * the token quota runs out, with a real handset buzzing throughout.
 *
 * Deliberately narrow, because a false positive silences a real customer.
 * Trips on either:
 *   (a) the same normalised inbound text AI_LOOP_REPEATS times in a row, when
 *       it is at least AI_LOOP_MIN_REPEAT_CHARS long — auto-replies are long
 *       boilerplate, while "yes" / "ok" / "thanks" repeat naturally;
 *   (b) a hard safety cap of AI_LOOP_HARD_CAP AI replies in AI_LOOP_WINDOW_MS.
 * Reply speed is NOT a signal: people who type in quick fragments look the
 * same as a bot by timing alone.
 *
 * Only messages after `resetAtMs` count — the last human reply or the last
 * loop pause — so a pause that is resumed (or expires) starts a fresh count
 * instead of re-tripping on the history that caused it.
 *
 * A second trip on the same conversation within AI_LOOP_REPEAT_OFF_WINDOW_MS
 * of the first means the 1h pause isn't holding — the bot turns OFF for that
 * conversation instead, until an operator re-enables it.
 */
export const AI_LOOP_REPEATS = 3;
export const AI_LOOP_MIN_REPEAT_CHARS = 40;
export const AI_LOOP_HARD_CAP = 30;
export const AI_LOOP_WINDOW_MS = 10 * 60 * 1000;
/** How long a tripped loop pauses the bot on the conversation. */
export const AI_LOOP_PAUSE_MS = 60 * 60 * 1000;
/** A second trip inside this window turns the bot off instead of re-pausing. */
export const AI_LOOP_REPEAT_OFF_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Rows scanned: enough for the hard cap (30 AI replies + their inbounds). */
const SCAN_LIMIT = 80;

export type AiLoopReason = "repeated_text" | "volume_cap";

interface Row {
  direction?: string;
  aiGenerated?: boolean;
  body?: string;
  at: number | null;
}

// Digit runs of 3+ fold to a single "#" so an auto-reply that varies only by
// a timestamp or ticket number ("Ticket #4821 opened 09:14" vs "#4822 09:17")
// still normalises equal instead of evading the repeated-text check. 1-2
// digit runs (a day-of-month like "5th", a small count) are left alone —
// folding those would make genuinely distinct short messages collide.
// Trade-off, accepted: a real auto-reply that varies ONLY by a 1-2 digit
// number ("case 5 opened" / "case 6 opened") still evades this check, same
// as before — the hard cap (AI_LOOP_HARD_CAP replies / AI_LOOP_WINDOW_MS)
// remains the backstop for that case.
const normalise = (s: string) =>
  s
    .toLowerCase()
    .replace(/\d{3,}/g, "#")
    .replace(/\s+/g, " ")
    .trim();

/** Pure decision over rows sorted NEWEST first. Exported for tests. */
export function loopReasonFromRows(
  rows: Row[],
  resetAtMs: number,
  nowMs: number,
): AiLoopReason | null {
  const live = rows.filter((r) => r.at === null || r.at > resetAtMs);

  // (a) The most recent inbounds all carry the same long text.
  const inbound = live
    .filter((r) => r.direction === "inbound" && typeof r.body === "string")
    .slice(0, AI_LOOP_REPEATS)
    .map((r) => normalise(r.body as string));
  if (
    inbound.length === AI_LOOP_REPEATS &&
    inbound[0].length >= AI_LOOP_MIN_REPEAT_CHARS &&
    inbound.every((t) => t === inbound[0])
  ) {
    return "repeated_text";
  }

  // (b) Hard cap.
  const since = nowMs - AI_LOOP_WINDOW_MS;
  const aiReplies = live.filter(
    (r) =>
      r.direction === "outbound" &&
      r.aiGenerated === true &&
      (r.at === null || r.at >= since),
  ).length;
  if (aiReplies >= AI_LOOP_HARD_CAP) return "volume_cap";

  return null;
}

/**
 * Reads the thread and decides. Fails SOFT: a read error returns null so a
 * real customer still gets their reply rather than being silently dropped.
 */
export async function detectAiReplyLoop(input: {
  contactId: string;
  messagesCollection: string;
  resetAtMs: number | null;
  nowMs?: number;
}): Promise<AiLoopReason | null> {
  const now = input.nowMs ?? Date.now();
  try {
    const snap = await getAdminDb()
      .collection("contacts")
      .doc(input.contactId)
      .collection(input.messagesCollection)
      .orderBy("createdAt", "desc")
      .limit(SCAN_LIMIT)
      .get();
    const rows: Row[] = snap.docs.map((d) => {
      const m = d.data() as {
        direction?: string;
        aiGenerated?: boolean;
        body?: string;
        createdAt?: { toMillis?: () => number } | null;
      };
      return {
        direction: m.direction,
        aiGenerated: m.aiGenerated,
        body: m.body,
        at:
          typeof m.createdAt?.toMillis === "function"
            ? m.createdAt.toMillis()
            : null,
      };
    });
    return loopReasonFromRows(rows, input.resetAtMs ?? 0, now);
  } catch (err) {
    console.warn("[ai/loop-guard] thread read failed; replying normally", err);
    return null;
  }
}

function toMillis(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  const t = (v as { toMillis?: () => number } | null | undefined)?.toMillis;
  return typeof t === "function" ? t.call(v) : null;
}

export interface LoopPauseResult {
  /** Whether the write succeeded (either the pause or the turn-off). */
  paused: boolean;
  /** True when this trip turned the bot off instead of pausing it. */
  turnedOff: boolean;
}

/**
 * Pause the bot on this conversation and stamp `aiLoopPausedAt`, which resets
 * the guard's window (see `getConversationControls`). `update`, not a
 * merge-set: the inbound upsert already created the doc with its tenancy keys.
 *
 * If the previous trip's `aiLoopPausedAt` is within AI_LOOP_REPEAT_OFF_WINDOW_MS,
 * the 1h pause isn't holding — this trip turns the bot OFF for the conversation
 * (`botMode: "off"`) instead, which only an operator can undo.
 */
export async function pauseBotForReplyLoop(
  conversationId: string,
): Promise<LoopPauseResult> {
  const now = Date.now();
  const ref = getAdminDb().collection("conversations").doc(conversationId);
  try {
    const snap = await ref.get();
    const prevTripAt = toMillis(snap.data()?.aiLoopPausedAt);
    const turnedOff =
      prevTripAt !== null && now - prevTripAt <= AI_LOOP_REPEAT_OFF_WINDOW_MS;
    if (turnedOff) {
      await ref.update({
        botMode: "off",
        botPausedUntil: null,
        aiLoopPausedAt: new Date(now),
      });
    } else {
      await ref.update({
        botPausedUntil: new Date(now + AI_LOOP_PAUSE_MS),
        aiLoopPausedAt: new Date(now),
      });
    }
    return { paused: true, turnedOff };
  } catch (err) {
    console.warn("[ai/loop-guard] pause write failed", err);
    return { paused: false, turnedOff: false };
  }
}

/** Escapes a value for safe interpolation into an HTML email body. */
export const escapeHtml = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Strips CR/LF from a value before it's interpolated into an email subject.
 * A subject built from customer-controlled text (contact name, message)
 * must not carry a raw newline, which some mail stacks would otherwise let
 * inject extra headers.
 */
export const stripEol = (v: string) => v.replace(/[\r\n]+/g, " ");

/**
 * Staff alert for a tripped loop — its own wording, not the keyword-escalation
 * template. Best-effort: a failed or unconfigured send is logged, never thrown.
 */
export async function sendReplyLoopNotification(params: {
  to: string;
  subAccountId: string;
  subAccount: SubAccountDoc;
  contactId: string;
  contactName: string;
  paused: boolean;
  /** True when this trip turned the bot off (second trip within 24h). */
  turnedOff: boolean;
  appUrl: string;
}): Promise<void> {
  if (!emailIsConfigured(params.subAccount)) {
    console.warn("[ai/loop-guard] email not configured — loop alert skipped");
    return;
  }
  const who = stripEol(params.contactName) || "a contact";
  const subject = params.turnedOff
    ? `AI auto-reply loop suspected — bot turned OFF on ${who}`
    : params.paused
      ? `AI auto-reply loop suspected — bot paused for 1h on ${who}`
      : `AI auto-reply loop suspected — pausing the bot FAILED on ${who}`;
  const link = `${params.appUrl}/sa/${params.subAccountId}/contacts/${params.contactId}`;
  const resumeInstruction = params.turnedOff
    ? "This is the second loop on this conversation within 24 hours, so the bot is now OFF for it — it will stay off until a human turns it back on, or"
    : params.paused
      ? "It will resume on its own after an hour, or"
      : "The bot is NOT paused. Turn it off for this conversation, or";
  const text = `${subject}.

The AI stopped replying because this conversation looks like two bots answering each other (for example the contact's own auto-reply).

${resumeInstruction} a human can reply or press Resume in the inbox:
${link}
`;
  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:32px auto;padding:0 16px;color:#1a1a22;line-height:1.6;">${text
    .split("\n")
    .map((l) => escapeHtml(l))
    .join("<br>")}</body></html>`;
  try {
    await sendEmail({
      archive: false,
      to: params.to,
      subject,
      text,
      html,
      from: tenantFrom(params.subAccount),
      subAccount: params.subAccount,
      meter: { subAccountId: params.subAccountId },
    });
  } catch (err) {
    console.error("[ai/loop-guard] loop alert send failed", err);
  }
}

/**
 * Staff PUSH alert for a tripped loop, sent unconditionally (unlike the
 * email above, which only fires when escalationNotifyEmail is configured).
 * Otherwise a workspace with no escalation email set has nothing telling
 * staff the bot went silent — the customer can sit unanswered indefinitely.
 * Uses the existing territory-scoped push system (lib/push/send.ts); a
 * missing VAPID config or no subscriptions is a silent no-op there.
 */
export async function sendReplyLoopPush(params: {
  subAccountId: string;
  agencyId: string;
  contactId: string;
  contactName: string;
  turnedOff: boolean;
  appUrl: string;
}): Promise<void> {
  const who = params.contactName || "a contact";
  await sendPushForEvent({
    subAccountId: params.subAccountId,
    agencyId: params.agencyId,
    title: params.turnedOff ? "AI bot turned OFF — reply loop" : "AI bot paused — reply loop",
    body: params.turnedOff
      ? `${who}: a second bot-to-bot loop tripped within 24h — the AI is off for this conversation until you turn it back on.`
      : `${who}: looks like two bots are replying to each other — the AI is paused here for 1 hour.`,
    url: `${params.appUrl}/sa/${params.subAccountId}/conversations/${params.contactId}`,
    tag: `ai-loop-${params.contactId}`,
    territoryId: await contactTerritoryId(params.contactId),
  });
}
