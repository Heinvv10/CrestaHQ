import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  errText,
  isLiveStatus,
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
 * Claiming a grant (`/voice/event {connected}`) and the reply endpoint's
 * question "is this token's call still reserved?". The conversation id comes
 * from the browser, so a claim is believed only when ElevenLabs agrees, and
 * each grant gets one id: a ping costs the client's key at most one lookup
 * (three on a 5xx), however many ids a caller tries.
 */

/** Lookups a claim makes on a 5xx before giving up. A 404 is final. */
const CONNECT_ATTEMPTS = 3;
const CONNECT_RETRY_MS = 1000;

/** The conversation, or null when it cannot be read (retried on 5xx only). */
async function lookupForClaim(input: {
  subAccountId: string;
  conversationId: string;
  apiKey: string;
  retryDelayMs: number;
}): Promise<ConversationSummary | null> {
  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
    try {
      return await getConversation(input.apiKey, input.conversationId);
    } catch (err) {
      const retryable = err instanceof ElevenLabsError && err.status >= 500;
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

/** Pin `conversationId` as the one id this grant may be claimed with. False
 *  when the grant is gone (claimed, lapsed, never issued) or another id was
 *  tried first. */
async function pinTriedId(ref: FirebaseFirestore.DocumentReference, grantId: string, conversationId: string): Promise<boolean> {
  const db = getAdminDb();
  return db.runTransaction(async (tx) => {
    const u = normalise((await tx.get(ref)).data() as Partial<WebVoiceUsageDoc> | undefined);
    const grant = own(u.grants, grantId);
    if (!grant) return false;
    if (grant.triedConversationId !== undefined) return grant.triedConversationId === conversationId;
    u.grants[grantId] = { ...grant, triedConversationId: conversationId };
    tx.set(ref, u);
    return true;
  });
}

/**
 * The visitor connected: move the grant to pending under the conversation
 * id. Claimed only while the grant is live, with the one id first tried on
 * it, and when ElevenLabs reports that conversation live on this
 * sub-account's agent and started after the grant was issued; anything else
 * claims nothing, and the grant lapses (and is charged) on its own.
 */
export async function markConnected(input: {
  subAccountId: string;
  grantId: string;
  conversationId: string;
  sessionId: string;
  conn: Pick<WebVoiceConnectionSecret, "apiKey" | "agentId">;
  /** Wait between 5xx retries; tests pass 0. */
  retryDelayMs?: number;
}): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(webVoiceUsagePath(input.subAccountId));
  // Written below as a key of `pending`: "__proto__" would set the prototype.
  if (input.conversationId in Object.prototype) return false;
  const grant = own((await readUsage(input.subAccountId)).grants, input.grantId);
  if (!grant || !input.conn.agentId) return false;
  if (!(await pinTriedId(ref, input.grantId, input.conversationId))) return false;

  const conv = await lookupForClaim({
    subAccountId: input.subAccountId,
    conversationId: input.conversationId,
    apiKey: input.conn.apiKey,
    retryDelayMs: input.retryDelayMs ?? CONNECT_RETRY_MS,
  });
  if (
    !conv ||
    conv.agentId !== input.conn.agentId ||
    !isLiveStatus(conv.status) ||
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
    if (!live || live.triedConversationId !== input.conversationId) return false;
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
