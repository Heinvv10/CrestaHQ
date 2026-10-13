import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  SIGNED_URL_MS,
  START_SKEW_MS,
  addSeconds,
  errText,
  markSettled,
  normalise,
  own,
  readUsage,
} from "@/lib/server/web-voice-usage-doc";
import { listConversations, type ConversationListItem } from "@/lib/web-voice/elevenlabs";
import {
  webVoiceUsagePath,
  type WebVoiceConnectionSecret,
  type WebVoiceLapsedGrant,
  type WebVoiceUsageDoc,
} from "@/types/web-voice";

/**
 * Server-side reconciliation of grants that lapsed unclaimed. Each one was
 * charged its full reservation when it lapsed (`normalise`), because the
 * browser may have used the signed URL without ever reporting the call.
 * Once every call such a grant could have produced has ended, ElevenLabs'
 * own conversation list for the agent is the record of what happened:
 *
 *   - every conversation in the window that no claim or earlier
 *     reconciliation has counted (not pending, not in `settled`) is matched
 *     to a ripe lapsed grant whose signed URL could have started it (issued
 *     at most `START_SKEW_MS` after, and `SIGNED_URL_MS` before, its start),
 *     earliest grant first;
 *   - a matched grant's charge is swapped for that call's real duration;
 *   - a ripe grant with no conversation for it is refunded;
 *   - a conversation no lapsed grant can absorb (a call run alongside a
 *     claimed one) is counted at its real duration.
 *
 * It changes nothing (every charge stays) when the list cannot be read in
 * full, or any conversation in the window is still running or has no
 * duration yet: it fails closed and the next sweep tries again. A refund or
 * swap only touches the counters the charge went into (same UTC day/month);
 * a seconds increase always lands today.
 *
 * ASSUMED, not runtime-verified: the list endpoint's filters and fields (see
 * `listConversations`).
 */

/** Pages of 100 read per reconciliation before giving up for this sweep. */
const MAX_PAGES = 5;

const isOpen = (c: ConversationListItem) =>
  c.status === "initiated" || c.status === "in-progress" || c.status === "processing" ||
  (c.status !== "failed" && c.durationSeconds === null);

const secondsOf = (c: ConversationListItem) =>
  c.status === "failed" ? 0 : Math.max(0, Math.round(c.durationSeconds ?? 0));

/** Apply a change to the counters a lapsed charge went into. */
function adjustCharge(u: WebVoiceUsageDoc, charge: WebVoiceLapsedGrant, delta: number): void {
  if (delta > 0) {
    addSeconds(u, delta);
    return;
  }
  if (u.day === charge.day) u.secondsToday = Math.max(0, u.secondsToday + delta);
  if (u.month === charge.month) u.secondsThisMonth = Math.max(0, u.secondsThisMonth + delta);
}

/** Read the agent's conversations started at or after `fromMs`; null when
 *  the list cannot be read in full this time. */
async function conversationsSince(
  subAccountId: string,
  conn: Pick<WebVoiceConnectionSecret, "apiKey">,
  agentId: string,
  fromMs: number,
): Promise<ConversationListItem[] | null> {
  const out: ConversationListItem[] = [];
  let cursor: string | null = null;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await listConversations(conn.apiKey, agentId, fromMs / 1000, cursor);
      out.push(...res.conversations);
      if (!res.hasMore) return out;
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
  } catch (err) {
    console.warn(`[web-voice] reconcile list failed sa=${subAccountId}`, errText(err));
    return null;
  }
  console.warn(`[web-voice] reconcile list incomplete sa=${subAccountId}: charges kept`);
  return null;
}

export async function reconcileLapsedGrants(input: {
  subAccountId: string;
  conn: Pick<WebVoiceConnectionSecret, "apiKey" | "agentId" | "maxCallSeconds">;
}): Promise<void> {
  const { subAccountId, conn } = input;
  const agentId = conn.agentId;
  if (!agentId) return;
  const now = Date.now();
  // Ripe = any call its signed URL could have started has certainly ended.
  const ripeAfterMs = SIGNED_URL_MS + conn.maxCallSeconds * 1000 + 2 * 60 * 1000;
  const ripe = Object.entries((await readUsage(subAccountId)).lapsed)
    .filter(([, g]) => now - g.issuedAtMs > ripeAfterMs)
    .sort(([, a], [, b]) => a.issuedAtMs - b.issuedAtMs);
  if (ripe.length === 0) return;

  const fromMs = ripe[0][1].issuedAtMs - START_SKEW_MS;
  const toMs = ripe[ripe.length - 1][1].issuedAtMs + SIGNED_URL_MS;
  const listed = await conversationsSince(subAccountId, conn, agentId, fromMs);
  if (!listed) return;
  const inWindow = listed.filter((c) => {
    const startMs = c.startTimeUnixSecs === null ? null : c.startTimeUnixSecs * 1000;
    return c.agentId === agentId && startMs !== null && startMs >= fromMs && startMs <= toMs;
  });
  if (inWindow.some(isOpen)) return;

  const db = getAdminDb();
  const ref = db.doc(webVoiceUsagePath(subAccountId));
  await db.runTransaction(async (tx) => {
    const u = normalise((await tx.get(ref)).data() as Partial<WebVoiceUsageDoc> | undefined);
    const counted = new Set([...Object.keys(u.pending), ...u.settled]);
    const grants = ripe
      .map(([id]) => ({ id, charge: own(u.lapsed, id) }))
      .filter((g): g is { id: string; charge: WebVoiceLapsedGrant } => !!g.charge);
    if (grants.length === 0) return;
    const open = inWindow
      .filter((c) => !counted.has(c.conversationId))
      .sort((a, b) => (a.startTimeUnixSecs ?? 0) - (b.startTimeUnixSecs ?? 0));

    const matched = new Map<string, ConversationListItem>();
    const unabsorbed: ConversationListItem[] = [];
    for (const c of open) {
      const startMs = (c.startTimeUnixSecs ?? 0) * 1000;
      const g = grants.find(
        (x) =>
          !matched.has(x.id) &&
          startMs >= x.charge.issuedAtMs - START_SKEW_MS &&
          startMs <= x.charge.issuedAtMs + SIGNED_URL_MS,
      );
      if (g) matched.set(g.id, c);
      else unabsorbed.push(c);
    }
    for (const g of grants) {
      const call = matched.get(g.id);
      adjustCharge(u, g.charge, (call ? secondsOf(call) : 0) - g.charge.chargedSeconds);
      delete u.lapsed[g.id];
    }
    for (const c of unabsorbed) addSeconds(u, secondsOf(c));
    markSettled(u, open.map((c) => c.conversationId));
    tx.set(ref, u);
  });
}
