import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  addSeconds,
  errText,
  isLiveStatus,
  markSettled,
  normalise,
  own,
  readUsage,
  startedAfterGrant,
} from "@/lib/server/web-voice-usage-doc";
import { ElevenLabsError, getConversation } from "@/lib/web-voice/elevenlabs";
import {
  webVoiceUsagePath,
  type WebVoiceConnectionSecret,
  type WebVoiceUsageDoc,
} from "@/types/web-voice";

/**
 * Settle one conversation: read its real duration from ElevenLabs and count
 * it once. Leaves it pending when ElevenLabs hasn't reported a duration yet
 * (the stale sweep retries). An id that is not pending — or, when
 * `sessionId` is given, is pending for another session — is ignored.
 */
export async function settleConversation(input: {
  subAccountId: string;
  conversationId: string;
  conn: Pick<WebVoiceConnectionSecret, "apiKey" | "agentId">;
  /** Counted when lookups keep failing past the give-up window, and for a
   *  conversation that cannot be attributed to this grant. */
  maxCallSeconds?: number;
  /** The browser's session: it may only settle its own calls. */
  sessionId?: string;
}): Promise<void> {
  const db = getAdminDb();
  const ref = db.doc(webVoiceUsagePath(input.subAccountId));
  const before = await readUsage(input.subAccountId);
  const pending = own(before.pending, input.conversationId);
  if (!pending) return;
  if (input.sessionId !== undefined && pending.sessionId !== input.sessionId) return;
  const fullReservation = input.maxCallSeconds ?? 0;

  // Past the longest possible call (+2 min slack) the conversation has
  // certainly ended, whatever ElevenLabs currently reports.
  const stale =
    input.maxCallSeconds !== undefined &&
    Date.now() - pending.startedAtMs > (input.maxCallSeconds + 120) * 1000;

  let seconds: number | null = null;
  try {
    const conv = await getConversation(input.conn.apiKey, input.conversationId);
    if (conv.agentId !== input.conn.agentId) {
      // Not this agent's conversation: release it, at the full reservation.
      seconds = fullReservation;
    } else if (isLiveStatus(conv.status) && !stale) {
      return; // still talking — keep the reservation
    } else if (!startedAfterGrant(conv.startTimeUnixSecs, pending.grantIssuedAtMs)) {
      // Started before its grant (or no start time): not this grant's call.
      seconds = fullReservation;
    } else if (conv.durationSeconds !== null) {
      seconds = conv.durationSeconds;
    } else if (conv.status === "failed") {
      seconds = 0;
    } else if (stale) {
      seconds = fullReservation;
    }
  } catch (err) {
    if (err instanceof ElevenLabsError && err.status === 404) {
      // No such conversation on this account (a forged id, or the key
      // changed): release it, at the full reservation.
      seconds = fullReservation;
    } else if (Date.now() - pending.startedAtMs > 30 * 60 * 1000) {
      // Lookups keep failing long after any call could have ended: release
      // the slot, counting the full reservation so the cap stays honest.
      seconds = fullReservation;
    } else {
      console.warn(
        `[web-voice] duration lookup failed sa=${input.subAccountId} conv=${input.conversationId}`,
        errText(err),
      );
      return;
    }
  }
  if (seconds === null) return;
  const counted = Math.max(0, Math.round(seconds));
  const sessionRef = db.doc(
    `subAccounts/${input.subAccountId}/webChatSessions/${pending.sessionId}`,
  );

  await db.runTransaction(async (tx) => {
    const [usageSnap, sessionSnap] = await Promise.all([tx.get(ref), tx.get(sessionRef)]);
    const u = normalise(usageSnap.data() as Partial<WebVoiceUsageDoc> | undefined);
    if (!own(u.pending, input.conversationId)) return;
    delete u.pending[input.conversationId];
    addSeconds(u, counted);
    markSettled(u, [input.conversationId]);
    tx.set(ref, u);
    if (counted > 0 && sessionSnap.exists) {
      tx.update(sessionRef, {
        voiceSeconds: FieldValue.increment(counted),
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  });
}
