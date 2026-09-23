import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { emailIsConfigured, sendEmail, tenantFrom } from "@/lib/comms/resend";
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
 */
export const AI_LOOP_REPEATS = 3;
export const AI_LOOP_MIN_REPEAT_CHARS = 40;
export const AI_LOOP_HARD_CAP = 30;
export const AI_LOOP_WINDOW_MS = 10 * 60 * 1000;
/** How long a tripped loop pauses the bot on the conversation. */
export const AI_LOOP_PAUSE_MS = 60 * 60 * 1000;

/** Rows scanned: enough for the hard cap (30 AI replies + their inbounds). */
const SCAN_LIMIT = 80;

export type AiLoopReason = "repeated_text" | "volume_cap";

interface Row {
  direction?: string;
  aiGenerated?: boolean;
  body?: string;
  at: number | null;
}

const normalise = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

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

/**
 * Pause the bot on this conversation and stamp `aiLoopPausedAt`, which resets
 * the guard's window (see `getConversationControls`). `update`, not a
 * merge-set: the inbound upsert already created the doc with its tenancy keys.
 * Returns whether the pause was written.
 */
export async function pauseBotForReplyLoop(conversationId: string): Promise<boolean> {
  const now = Date.now();
  try {
    await getAdminDb()
      .collection("conversations")
      .doc(conversationId)
      .update({
        botPausedUntil: new Date(now + AI_LOOP_PAUSE_MS),
        aiLoopPausedAt: new Date(now),
      });
    return true;
  } catch (err) {
    console.warn("[ai/loop-guard] pause write failed", err);
    return false;
  }
}

const escapeHtml = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

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
  appUrl: string;
}): Promise<void> {
  if (!emailIsConfigured(params.subAccount)) {
    console.warn("[ai/loop-guard] email not configured — loop alert skipped");
    return;
  }
  const who = params.contactName || "a contact";
  const subject = params.paused
    ? `AI auto-reply loop suspected — bot paused for 1h on ${who}`
    : `AI auto-reply loop suspected — pausing the bot FAILED on ${who}`;
  const link = `${params.appUrl}/sa/${params.subAccountId}/contacts/${params.contactId}`;
  const text = `${subject}.

The AI stopped replying because this conversation looks like two bots answering each other (for example the contact's own auto-reply).

${params.paused ? "It will resume on its own after an hour, or" : "The bot is NOT paused. Turn it off for this conversation, or"} a human can reply or press Resume in the inbox:
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
