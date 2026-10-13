import "server-only";

import { randomBytes } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { ElevenLabsError, getConversation } from "@/lib/web-voice/elevenlabs";
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
 *      grant id is recorded (a visitor holding a signed URL who hasn't
 *      connected yet still counts against concurrency).
 *   2. `/voice/event {connected}` → `markConnected()`: grant → pending,
 *      keyed by the ElevenLabs conversation id.
 *   3. `/voice/event {ended}` (or a later sweep) → `settleConversation()`:
 *      the duration is read FROM ELEVENLABS (never trusted from the browser)
 *      and added to today's + this month's counters exactly once.
 *
 * Cap math is conservative: every pending conversation is assumed to run the
 * full `maxCallSeconds` until settled, so the daily cap can't be overshot by
 * several visitors talking at once. Days are UTC.
 *
 * Ours differs from upstream in these places, each failing closed:
 *   - `pending` and `grants` are keyed by caller-supplied ids, so they are
 *     only ever read as OWN properties: "__proto__" or "constructor" must
 *     not look like a pending call (it settled a phantom reservation into
 *     the counters on every ping);
 *   - a grant is claimed only by a conversation ElevenLabs reports as live
 *     on THIS agent, so a forged id or an old, finished conversation cannot
 *     stand in for the call actually being made;
 *   - the reply endpoint answers a session token only while its grant is
 *     live or claimed (`voiceTurnAllowed`), so a conversation the widget
 *     never reported gets no AI replies once its reservation lapses;
 *   - a conversation ElevenLabs does not know (404) or attributes to another
 *     agent is counted at the full reservation, never released for free;
 *   - the session's `voiceSeconds` is added in the same transaction that
 *     removes the pending entry, so two racing settles count it once.
 */

/** Grants unclaimed for longer than this are abandoned (signed URL unused). */
const GRANT_LIVE_MS = 2 * 60 * 1000;
/** A grant can still be claimed up to the signed-URL lifetime. */
const GRANT_MAX_MS = 16 * 60 * 1000;
/** Settled-id ring size (dedupe for repeated /end beacons). */
const SETTLED_RING = 200;

export class WebVoiceLimitError extends Error {
  constructor(
    message: string,
    public reason: "daily_cap" | "busy",
  ) {
    super(message);
    this.name = "WebVoiceLimitError";
  }
}

/** The only form of a caught error this module logs: never the object. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}
function utcMonth(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

function emptyUsage(): WebVoiceUsageDoc {
  return {
    day: utcDay(),
    secondsToday: 0,
    month: utcMonth(),
    secondsThisMonth: 0,
    pending: {},
    grants: {},
    settled: [],
  };
}

/** Normalise a stored doc and roll the day/month counters over. */
function normalise(raw: Partial<WebVoiceUsageDoc> | undefined): WebVoiceUsageDoc {
  const u: WebVoiceUsageDoc = { ...emptyUsage(), ...(raw ?? {}) };
  u.pending = { ...(u.pending ?? {}) };
  u.grants = { ...(u.grants ?? {}) };
  u.settled = Array.isArray(u.settled) ? [...u.settled] : [];
  if (u.day !== utcDay()) {
    u.day = utcDay();
    u.secondsToday = 0;
  }
  if (u.month !== utcMonth()) {
    u.month = utcMonth();
    u.secondsThisMonth = 0;
  }
  const now = Date.now();
  for (const [id, at] of Object.entries(u.grants)) {
    if (now - at > GRANT_MAX_MS) delete u.grants[id];
  }
  return u;
}

/** `rec[key]` only when it is the record's own entry — never an inherited
 *  `Object.prototype` member named by a caller-supplied id. */
function own<T>(rec: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(rec, key) ? rec[key] : undefined;
}

function liveGrantCount(u: WebVoiceUsageDoc): number {
  const now = Date.now();
  return Object.values(u.grants).filter((at) => now - at <= GRANT_LIVE_MS).length;
}

/** Seconds counted against today's cap, including reservations. */
function committedSeconds(u: WebVoiceUsageDoc, maxCallSeconds: number): number {
  const reserved =
    (Object.keys(u.pending).length + liveGrantCount(u)) * maxCallSeconds;
  return u.secondsToday + reserved;
}

async function readUsage(subAccountId: string): Promise<WebVoiceUsageDoc> {
  const snap = await getAdminDb().doc(webVoiceUsagePath(subAccountId)).get();
  return normalise(snap.data() as Partial<WebVoiceUsageDoc> | undefined);
}

/** Cheap read for the widget config: is there room for one more call? */
export async function webVoiceCapReached(
  subAccountId: string,
  conn: Pick<WebVoiceConnectionSecret, "dailyMinuteCap" | "maxCallSeconds">,
): Promise<boolean> {
  const u = await readUsage(subAccountId);
  // Only SETTLED seconds hide the mic — reservations from people talking
  // right now shouldn't make the button flicker for everyone else.
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
    const active = Object.keys(u.pending).length + liveGrantCount(u);
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
    u.grants[grantId] = Date.now();
    tx.set(ref, u);
  });
  return grantId;
}

/**
 * The visitor connected: move the grant to pending under the conversation
 * id. The id comes from the browser, so it is claimed only when ElevenLabs
 * reports that conversation as live on this sub-account's agent; anything
 * else (unknown, finished, another agent's, or a failed lookup) claims
 * nothing, and the grant lapses on its own.
 */
export async function markConnected(input: {
  subAccountId: string;
  grantId: string;
  conversationId: string;
  sessionId: string;
  conn: Pick<WebVoiceConnectionSecret, "apiKey" | "agentId">;
}): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(webVoiceUsagePath(input.subAccountId));
  // Written below as a key of `pending`: "__proto__" would set the prototype.
  if (input.conversationId in Object.prototype) return false;
  const before = await readUsage(input.subAccountId);
  if (!Object.hasOwn(before.grants, input.grantId)) return false;
  try {
    const conv = await getConversation(input.conn.apiKey, input.conversationId);
    const live = conv.status === "initiated" || conv.status === "in-progress";
    if (!input.conn.agentId || conv.agentId !== input.conn.agentId || !live) return false;
  } catch (err) {
    console.warn(
      `[web-voice] connect lookup failed sa=${input.subAccountId} conv=${input.conversationId}`,
      errText(err),
    );
    return false;
  }
  return db.runTransaction(async (tx) => {
    const u = normalise((await tx.get(ref)).data() as Partial<WebVoiceUsageDoc> | undefined);
    if (u.settled.includes(input.conversationId)) return false;
    if (own(u.pending, input.conversationId)) return false;
    // Only an outstanding grant can be claimed — stops a replayed token from
    // registering extra conversations.
    if (!Object.hasOwn(u.grants, input.grantId)) return false;
    delete u.grants[input.grantId];
    u.pending[input.conversationId] = {
      sessionId: input.sessionId,
      grantId: input.grantId,
      startedAtMs: Date.now(),
    };
    tx.set(ref, u);
    return true;
  });
}

/**
 * May the reply endpoint answer a turn carrying this session token? Only
 * while its grant still holds a reservation: outstanding and young enough
 * to count against concurrency, or claimed by a conversation that has not
 * been settled. A settled call, a lapsed grant or a grant from another
 * session gets no reply.
 */
export async function voiceTurnAllowed(input: {
  subAccountId: string;
  sessionId: string;
  grantId: string;
}): Promise<boolean> {
  const u = await readUsage(input.subAccountId);
  const issuedAt = own(u.grants, input.grantId);
  if (typeof issuedAt === "number" && Date.now() - issuedAt <= GRANT_LIVE_MS) return true;
  return Object.values(u.pending).some(
    (p) => p.grantId === input.grantId && p.sessionId === input.sessionId,
  );
}

/**
 * Settle one conversation: read its real duration from ElevenLabs and count
 * it once. Leaves it pending when ElevenLabs hasn't reported a duration yet
 * (the stale sweep retries). An id that is not pending is ignored.
 */
export async function settleConversation(input: {
  subAccountId: string;
  conversationId: string;
  conn: Pick<WebVoiceConnectionSecret, "apiKey" | "agentId">;
  /** Counted when lookups keep failing past the give-up window, and for a
   *  conversation that cannot be attributed to this agent. */
  maxCallSeconds?: number;
}): Promise<void> {
  const db = getAdminDb();
  const ref = db.doc(webVoiceUsagePath(input.subAccountId));
  const before = await readUsage(input.subAccountId);
  const pending = own(before.pending, input.conversationId);
  if (!pending) return;
  const fullReservation = input.maxCallSeconds ?? 0;

  // Past the longest possible call (+2 min slack) the conversation has
  // certainly ended, whatever ElevenLabs currently reports.
  const stale =
    input.maxCallSeconds !== undefined &&
    Date.now() - pending.startedAtMs > (input.maxCallSeconds + 120) * 1000;

  let seconds: number | null = null;
  try {
    const conv = await getConversation(input.conn.apiKey, input.conversationId);
    const live = conv.status === "initiated" || conv.status === "in-progress";
    if (conv.agentId !== input.conn.agentId) {
      // Not this agent's conversation: release it, at the full reservation.
      seconds = fullReservation;
    } else if (live && !stale) {
      return; // still talking — keep the reservation
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
    u.secondsToday += counted;
    u.secondsThisMonth += counted;
    u.settled = [...u.settled, input.conversationId].slice(-SETTLED_RING);
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
 * finalised the duration when the ping arrived). Called from /voice/start
 * so concurrency + cap stay accurate without a cron. Pending is bounded by
 * the concurrency cap, so this is at most a few reads.
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
}
