import "server-only";

import { randomBytes } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { reconcileLapsedGrants } from "@/lib/server/web-voice-reconcile";
import {
  addSeconds,
  errText,
  markSettled,
  normalise,
  own,
  readUsage,
  startedAfterGrant,
} from "@/lib/server/web-voice-usage-doc";
import { ElevenLabsError, getConversation, type ConversationSummary } from "@/lib/web-voice/elevenlabs";
import {
  WEB_VOICE_LIMITS,
  webVoiceUsagePath,
  type WebVoiceConnectionSecret,
  type WebVoiceUsageDoc,
} from "@/types/web-voice";

/**
 * Web Voice minute accounting + caps. One server-only doc per sub-account
 * (`private/webVoiceUsage`), mutated in transactions.
 *
 * Lifecycle of one conversation:
 *   1. `/voice/start` → `reserveGrant()`: cap + concurrency check, then a
 *      grant is recorded. It counts against both for `GRANT_LIVE_MS` — the
 *      same window in which it can be claimed.
 *   2. `/voice/event {connected}` → `markConnected()`: grant → pending,
 *      keyed by the ElevenLabs conversation id, only for a conversation
 *      ElevenLabs reports live on this agent and started after the grant.
 *   3. `/voice/event {ended}` (or a later sweep) → `settleConversation()`:
 *      the duration is read FROM ELEVENLABS (never trusted from the browser)
 *      and added to today's + this month's counters exactly once.
 *   A grant nobody claims lapses: it is CHARGED its full reservation then
 *   (`normalise`), and reconciliation (`web-voice-reconcile.ts`) later swaps
 *   that charge for the real duration of the call ElevenLabs shows for it,
 *   or refunds it when ElevenLabs shows none.
 *
 * Cap math is conservative: every pending conversation is assumed to run the
 * full `maxCallSeconds` until settled, so the daily cap can't be overshot by
 * several visitors talking at once. Days are UTC.
 *
 * Ours differs from upstream in these places, each failing closed:
 *   - an unclaimed grant is charged, not forgotten: a visitor who uses the
 *     signed URL and never reports the call still pays for it;
 *   - `pending`, `grants` and `lapsed` are keyed by ids, some caller-supplied,
 *     so they are only ever read as OWN properties ("__proto__" or
 *     "constructor" must not look like a pending call);
 *   - a claim needs a conversation ElevenLabs reports live on THIS agent,
 *     started after the grant was issued; settling re-checks both, so a
 *     short or old call cannot stand in for the one actually made;
 *   - the reply endpoint answers a session token only while its grant is
 *     live or claimed (`voiceTurnAllowed`);
 *   - a conversation ElevenLabs does not know (404), attributes to another
 *     agent or started before its grant is counted at the full reservation;
 *   - the session's `voiceSeconds` is added in the same transaction that
 *     removes the pending entry, so two racing settles count it once.
 */

/** Lookups a claim makes before giving up: ElevenLabs may not have indexed
 *  a conversation the instant the browser reports it. */
const CONNECT_ATTEMPTS = 3;
const CONNECT_RETRY_MS = 1000;

export class WebVoiceLimitError extends Error {
  constructor(
    message: string,
    public reason: "daily_cap" | "busy",
  ) {
    super(message);
    this.name = "WebVoiceLimitError";
  }
}

const isLive = (status: string | null) => status === "initiated" || status === "in-progress";

/** Seconds counted against today's cap, including reservations. */
function committedSeconds(u: WebVoiceUsageDoc, maxCallSeconds: number): number {
  const reserved = (Object.keys(u.pending).length + Object.keys(u.grants).length) * maxCallSeconds;
  return u.secondsToday + reserved;
}

/** Cheap read for the widget config: is there room for one more call? */
export async function webVoiceCapReached(
  subAccountId: string,
  conn: Pick<WebVoiceConnectionSecret, "dailyMinuteCap" | "maxCallSeconds">,
): Promise<boolean> {
  const u = await readUsage(subAccountId);
  // Only counted seconds (settled and lapsed) hide the mic — reservations
  // from people talking right now shouldn't make the button flicker.
  return u.secondsToday + conn.maxCallSeconds > conn.dailyMinuteCap * 60;
}

/** Display numbers for the settings card. */
export async function getWebVoiceUsage(subAccountId: string): Promise<{
  secondsToday: number;
  secondsThisMonth: number;
  activeNow: number;
}> {
  const u = await readUsage(subAccountId);
  return {
    secondsToday: u.secondsToday,
    secondsThisMonth: u.secondsThisMonth,
    activeNow: Object.keys(u.pending).length,
  };
}

/** Reserve capacity for one new conversation. Throws WebVoiceLimitError. */
export async function reserveGrant(
  subAccountId: string,
  conn: Pick<WebVoiceConnectionSecret, "dailyMinuteCap" | "maxCallSeconds">,
): Promise<string> {
  const db = getAdminDb();
  const ref = db.doc(webVoiceUsagePath(subAccountId));
  const grantId = randomBytes(12).toString("base64url");
  await db.runTransaction(async (tx) => {
    const u = normalise((await tx.get(ref)).data() as Partial<WebVoiceUsageDoc> | undefined);
    const active = Object.keys(u.pending).length + Object.keys(u.grants).length;
    if (active >= WEB_VOICE_LIMITS.concurrency) {
      throw new WebVoiceLimitError(
        "Voice is busy right now — please type your message instead.",
        "busy",
      );
    }
    if (committedSeconds(u, conn.maxCallSeconds) + conn.maxCallSeconds > conn.dailyMinuteCap * 60) {
      throw new WebVoiceLimitError(
        "Voice isn't available right now — please type your message instead.",
        "daily_cap",
      );
    }
    u.grants[grantId] = { issuedAtMs: Date.now(), seconds: conn.maxCallSeconds };
    tx.set(ref, u);
  });
  return grantId;
}

/** The conversation, looked up with retries on 404 and 5xx (not indexed
 *  yet, or a blip). Null when it still cannot be read. */
async function lookupForClaim(
  input: { subAccountId: string; conversationId: string; apiKey: string; retryDelayMs: number },
): Promise<ConversationSummary | null> {
  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
    try {
      return await getConversation(input.apiKey, input.conversationId);
    } catch (err) {
      const retryable = err instanceof ElevenLabsError && (err.status === 404 || err.status >= 500);
      if (!retryable || attempt === CONNECT_ATTEMPTS) {
        console.warn(
          `[web-voice] connect lookup failed sa=${input.subAccountId} conv=${input.conversationId}`,
          errText(err),
        );
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, input.retryDelayMs));
    }
  }
  return null;
}

/**
 * The visitor connected: move the grant to pending under the conversation
 * id. The id comes from the browser, so it is claimed only while the grant
 * is still live, and only when ElevenLabs reports that conversation live on
 * this sub-account's agent and started after the grant was issued; anything
 * else claims nothing, and the grant lapses (and is charged) on its own.
 */
export async function markConnected(input: {
  subAccountId: string;
  grantId: string;
  conversationId: string;
  sessionId: string;
  conn: Pick<WebVoiceConnectionSecret, "apiKey" | "agentId">;
  /** Wait between lookup retries; tests pass 0. */
  retryDelayMs?: number;
}): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(webVoiceUsagePath(input.subAccountId));
  // Written below as a key of `pending`: "__proto__" would set the prototype.
  if (input.conversationId in Object.prototype) return false;
  const grant = own((await readUsage(input.subAccountId)).grants, input.grantId);
  if (!grant || !input.conn.agentId) return false;

  const conv = await lookupForClaim({
    subAccountId: input.subAccountId,
    conversationId: input.conversationId,
    apiKey: input.conn.apiKey,
    retryDelayMs: input.retryDelayMs ?? CONNECT_RETRY_MS,
  });
  if (
    !conv ||
    conv.agentId !== input.conn.agentId ||
    !isLive(conv.status) ||
    !startedAfterGrant(conv.startTimeUnixSecs, grant.issuedAtMs)
  ) {
    return false;
  }

  return db.runTransaction(async (tx) => {
    const u = normalise((await tx.get(ref)).data() as Partial<WebVoiceUsageDoc> | undefined);
    if (u.settled.includes(input.conversationId)) return false;
    if (own(u.pending, input.conversationId)) return false;
    // Only a grant that is still live can be claimed — a replayed token, or
    // one whose grant lapsed (and was charged), registers nothing.
    const live = own(u.grants, input.grantId);
    if (!live) return false;
    // The grant already counts, so this only refuses when pending alone is
    // full (the limit was lowered, or the doc was written by older code).
    if (Object.keys(u.pending).length >= WEB_VOICE_LIMITS.concurrency) return false;
    delete u.grants[input.grantId];
    u.pending[input.conversationId] = {
      sessionId: input.sessionId,
      grantId: input.grantId,
      grantIssuedAtMs: live.issuedAtMs,
      startedAtMs: Date.now(),
    };
    tx.set(ref, u);
    return true;
  });
}

/**
 * May the reply endpoint answer a turn carrying this session token? Only
 * while its grant still holds a reservation: live (claimable), or claimed by
 * a conversation that has not been settled. A settled call, a lapsed grant
 * or a grant from another session gets no reply.
 */
export async function voiceTurnAllowed(input: {
  subAccountId: string;
  sessionId: string;
  grantId: string;
}): Promise<boolean> {
  const u = await readUsage(input.subAccountId);
  if (own(u.grants, input.grantId)) return true;
  return Object.values(u.pending).some(
    (p) => p.grantId === input.grantId && p.sessionId === input.sessionId,
  );
}

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
    } else if (isLive(conv.status) && !stale) {
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

/**
 * Re-check pending conversations against ElevenLabs and settle the ones
 * that have finished (tab closed before the end ping, or ElevenLabs hadn't
 * finalised the duration when the ping arrived), then reconcile lapsed
 * grants against the agent's conversation list. Called from /voice/start so
 * concurrency + cap stay accurate without a cron. Pending is bounded by the
 * concurrency cap, so this is at most a few reads.
 */
export async function sweepStalePending(input: {
  subAccountId: string;
  conn: Pick<WebVoiceConnectionSecret, "apiKey" | "agentId" | "maxCallSeconds">;
}): Promise<void> {
  const u = await readUsage(input.subAccountId);
  // Skip calls that started seconds ago — they're certainly still live.
  const cutoff = Date.now() - 15_000;
  const stale = Object.entries(u.pending)
    .filter(([, p]) => p.startedAtMs < cutoff)
    .slice(0, 5)
    .map(([id]) => id);
  await Promise.all(
    stale.map((conversationId) =>
      settleConversation({
        subAccountId: input.subAccountId,
        conversationId,
        conn: input.conn,
        maxCallSeconds: input.conn.maxCallSeconds,
      }),
    ),
  );
  await reconcileLapsedGrants(input);
}
