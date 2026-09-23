import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";

/**
 * Bot-to-bot reply-loop guard.
 *
 * A customer's own auto-responder (WhatsApp Business away message, an SMS
 * autoresponder) answers every AI reply, and the AI answers it back — until
 * the token quota runs out, with a real handset buzzing throughout.
 *
 * It detects MACHINE behaviour, not volume: a real customer having a quick
 * back-and-forth with the bot must never be silenced. Trips on any of:
 *   (a) AI_LOOP_FAST_EXCHANGES consecutive exchanges where the inbound arrived
 *       within AI_LOOP_FAST_REPLY_MS of our previous AI reply — auto-responders
 *       answer instantly, people read and type;
 *   (b) the same normalised inbound text AI_LOOP_REPEATS times in a row;
 *   (c) a hard safety cap of AI_LOOP_HARD_CAP AI replies in AI_LOOP_WINDOW_MS.
 *
 * Only messages after `resetAtMs` count — the last human reply or the last
 * loop pause — so a pause that is resumed (or expires) starts a fresh count
 * instead of re-tripping on the history that caused it.
 */
export const AI_LOOP_FAST_REPLY_MS = 8_000;
export const AI_LOOP_FAST_EXCHANGES = 4;
export const AI_LOOP_REPEATS = 3;
export const AI_LOOP_HARD_CAP = 30;
export const AI_LOOP_WINDOW_MS = 10 * 60 * 1000;
/** How long a tripped loop pauses the bot on the conversation. */
export const AI_LOOP_PAUSE_MS = 60 * 60 * 1000;

/** Rows scanned: enough for the hard cap (30 AI replies + their inbounds). */
const SCAN_LIMIT = 80;

export type AiLoopReason = "auto_responder" | "repeated_text" | "volume_cap";

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

  // (a) Newest first: `inboundAt` is the earliest inbound seen since the last
  // outbound, i.e. the reply to that outbound. Seeded with `now` in case the
  // current inbound's row is not readable yet.
  let fast = 0;
  let inboundAt: number | null = nowMs;
  for (const r of live) {
    if (r.direction === "inbound") {
      inboundAt = r.at ?? inboundAt;
      continue;
    }
    if (r.direction !== "outbound") continue;
    if (
      r.aiGenerated !== true ||
      r.at === null ||
      inboundAt === null ||
      inboundAt - r.at > AI_LOOP_FAST_REPLY_MS
    ) {
      break;
    }
    fast++;
    inboundAt = null;
  }
  if (fast >= AI_LOOP_FAST_EXCHANGES) return "auto_responder";

  // (b) The most recent inbounds all say the same thing.
  const inbound = live
    .filter((r) => r.direction === "inbound" && typeof r.body === "string")
    .slice(0, AI_LOOP_REPEATS)
    .map((r) => normalise(r.body as string));
  if (
    inbound.length === AI_LOOP_REPEATS &&
    inbound[0] !== "" &&
    inbound.every((t) => t === inbound[0])
  ) {
    return "repeated_text";
  }

  // (c) Hard cap.
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
