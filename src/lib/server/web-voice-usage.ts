import "server-only";

import { randomBytes } from "node:crypto";
import { getAdminDb } from "@/lib/firebase/admin";
import { reconcileUsage } from "@/lib/server/web-voice-reconcile";
import { settleConversation } from "@/lib/server/web-voice-settle";
import { START_SKEW_MS, normalise, own, readUsage } from "@/lib/server/web-voice-usage-doc";
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
 *   (`normalise`). ElevenLabs' conversation list is the source of truth:
 *   every sweep counts every call of the agent no claim covered and, once a
 *   lapsed grant's signed URL has expired behind the watermark, refunds its
 *   provisional charge (`web-voice-reconcile.ts`).
 *
 * Split by step: claims in `web-voice-claim.ts`, settling in
 * `web-voice-settle.ts`, reconciliation in `web-voice-reconcile.ts`, the doc
 * rules in `web-voice-usage-doc.ts`. This module is the public face.
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

export class WebVoiceLimitError extends Error {
  constructor(
    message: string,
    public reason: "daily_cap" | "busy",
  ) {
    super(message);
    this.name = "WebVoiceLimitError";
  }
}

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
  conn: Pick<WebVoiceConnectionSecret, "dailyMinuteCap" | "maxCallSeconds" | "agentId">,
): Promise<string> {
  const agentId = conn.agentId;
  if (!agentId) throw new Error("reserveGrant needs a provisioned agent");
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
    const now = Date.now();
    // Start this agent's watermark at its first grant: a private agent can
    // have no conversation before a signed URL we minted. Kept per agent, so
    // a re-key back to an earlier agent resumes that agent's own watermark.
    if (own(u.watermarks, agentId) === undefined) u.watermarks[agentId] = now - START_SKEW_MS;
    u.grants[grantId] = { issuedAtMs: now, seconds: conn.maxCallSeconds, agentId };
    tx.set(ref, u);
  });
  return grantId;
}

/**
 * Re-check pending conversations against ElevenLabs and settle the ones
 * that have finished (tab closed before the end ping, or ElevenLabs hadn't
 * finalised the duration when the ping arrived), then reconcile against the
 * agent's conversation list. Called from /voice/start, and from
 * web-chat/config when the cap looks reached, so the cap stays accurate
 * without a cron. Pending is bounded by the
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
  await reconcileUsage(input);
}

export { claimHeld, markConnected, voiceTurnAllowed } from "@/lib/server/web-voice-claim";
export { settleConversation } from "@/lib/server/web-voice-settle";
