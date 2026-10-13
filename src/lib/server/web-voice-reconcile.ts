import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  SIGNED_URL_MS,
  START_SKEW_MS,
  addSeconds,
  errText,
  markSettled,
  normalise,
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
 * ElevenLabs' conversation list is the source of truth for Web Voice
 * minutes. The usage doc carries a WATERMARK, `reconciledThroughMs` for
 * `reconciledAgentId`: every conversation of that agent that started before
 * it has been counted. Each sweep:
 *
 *   1. lists ALL the agent's conversations that started in
 *      [watermark, now − ripe), where ripe = `maxCallSeconds` + 2 min, so
 *      every call in range has ended;
 *   2. counts each one that no claim covers (not pending, not settled) at
 *      its real duration — a call the browser never reported, or one run on
 *      another call's signed URL or token, is counted all the same;
 *   3. refunds every lapsed grant of this agent whose signed URL expired
 *      before the new watermark: any call it started has now been counted
 *      in its own right, so its provisional full charge goes;
 *   4. advances the watermark, in the same transaction, only if no other
 *      sweep moved it first.
 *
 * Any doubt about the list and the sweep does NOTHING (charges stay, the
 * watermark stays) and logs why: the list cannot be read in full, is not an
 * array, or an item in or possibly in range has no id, agent, start time or
 * duration, or is still running without being pending. Lapsed grants of an
 * earlier agent (re-key) are never refunded: their charges stand.
 *
 * ASSUMED, not runtime-verified: the list endpoint's filters, fields and
 * paging (see `listConversations`); the contract test pins our reading.
 */

/** Pages of 100 read per sweep; more means doubt (nothing changes). */
const MAX_PAGES = 10;

const OPEN_STATUSES = new Set(["initiated", "in-progress", "processing"]);

type Doubt = { reason: string; count: number };

/** Read every conversation of the agent started at or after `fromMs`, or
 *  null when the list cannot be read in full. */
async function listSince(
  subAccountId: string,
  apiKey: string,
  agentId: string,
  fromMs: number,
): Promise<ConversationListItem[] | null> {
  const out: ConversationListItem[] = [];
  let cursor: string | null = null;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await listConversations(apiKey, agentId, fromMs / 1000, cursor);
      out.push(...res.conversations);
      if (!res.hasMore) return out;
      if (!res.nextCursor) break;
      cursor = res.nextCursor;
    }
  } catch (err) {
    console.warn(`[web-voice] reconcile: list failed sa=${subAccountId}; nothing changed`, errText(err));
    return null;
  }
  console.warn(`[web-voice] reconcile: list incomplete sa=${subAccountId}; nothing changed`);
  return null;
}

/** The calls in [fromMs, toMs) to count, or a doubt. `counted` = ids a
 *  claim already covers (pending or settled). */
function callsToCount(
  listed: ConversationListItem[],
  agentId: string,
  fromMs: number,
  toMs: number,
  counted: Set<string>,
): { calls: ConversationListItem[] } | { doubt: Doubt } {
  const doubts = new Map<string, number>();
  const doubt = (reason: string) => doubts.set(reason, (doubts.get(reason) ?? 0) + 1);
  const calls: ConversationListItem[] = [];
  for (const c of listed) {
    if (c.agentId !== null && c.agentId !== agentId) continue; // another agent's: not ours
    if (c.startTimeUnixSecs === null) {
      doubt("no start time");
      continue;
    }
    const startMs = c.startTimeUnixSecs * 1000;
    if (startMs < fromMs || startMs >= toMs) continue;
    if (c.conversationId === null) doubt("no conversation id");
    else if (c.agentId === null) doubt("no agent id");
    else if (counted.has(c.conversationId)) continue;
    else if (c.status !== null && OPEN_STATUSES.has(c.status)) doubt("still running");
    else if (c.status !== "failed" && c.durationSeconds === null) doubt("no duration");
    else calls.push(c);
  }
  if (doubts.size > 0) {
    const reason = [...doubts].map(([r, n]) => `${n} ${r}`).join(", ");
    return { doubt: { reason, count: [...doubts.values()].reduce((a, b) => a + b, 0) } };
  }
  return { calls };
}

const secondsOf = (c: ConversationListItem) =>
  c.status === "failed" ? 0 : Math.max(0, Math.round(c.durationSeconds ?? 0));

/** Take a lapsed grant's charge back off the counters it went into. */
function refund(u: WebVoiceUsageDoc, charge: WebVoiceLapsedGrant): void {
  if (u.day === charge.day) u.secondsToday = Math.max(0, u.secondsToday - charge.chargedSeconds);
  if (u.month === charge.month) u.secondsThisMonth = Math.max(0, u.secondsThisMonth - charge.chargedSeconds);
}

export async function reconcileUsage(input: {
  subAccountId: string;
  conn: Pick<WebVoiceConnectionSecret, "apiKey" | "agentId" | "maxCallSeconds">;
}): Promise<void> {
  const { subAccountId, conn } = input;
  const agentId = conn.agentId;
  if (!agentId) return;
  const before = await readUsage(subAccountId);
  const fromMs = before.reconciledThroughMs;
  // No grant has been minted for this agent yet: there is nothing to count.
  if (fromMs === null || before.reconciledAgentId !== agentId) return;
  const ripeMs = conn.maxCallSeconds * 1000 + 2 * 60 * 1000;
  const toMs = Math.floor((Date.now() - ripeMs) / 1000) * 1000;
  if (toMs <= fromMs) return;

  const listed = await listSince(subAccountId, conn.apiKey, agentId, fromMs);
  if (!listed) return;

  const db = getAdminDb();
  const ref = db.doc(webVoiceUsagePath(subAccountId));
  await db.runTransaction(async (tx) => {
    const u = normalise((await tx.get(ref)).data() as Partial<WebVoiceUsageDoc> | undefined);
    if (u.reconciledThroughMs !== fromMs || u.reconciledAgentId !== agentId) return; // another sweep won
    const counted = new Set([...Object.keys(u.pending), ...u.settled]);
    const result = callsToCount(listed, agentId, fromMs, toMs, counted);
    if ("doubt" in result) {
      console.warn(
        `[web-voice] reconcile: ${result.doubt.count} doubtful conversation(s) sa=${subAccountId} (${result.doubt.reason}); nothing changed`,
      );
      return;
    }
    for (const c of result.calls) addSeconds(u, secondsOf(c));
    markSettled(u, result.calls.map((c) => c.conversationId as string));
    for (const [id, charge] of Object.entries(u.lapsed)) {
      const expiredBy = charge.issuedAtMs + SIGNED_URL_MS + START_SKEW_MS;
      if (expiredBy > toMs) continue;
      // Another agent's (a re-key): its calls are not on this list, so the
      // charge stands; the entry just stops being tracked.
      if (charge.agentId === agentId) refund(u, charge);
      delete u.lapsed[id];
    }
    u.reconciledThroughMs = toMs;
    tx.set(ref, u);
  });
}
