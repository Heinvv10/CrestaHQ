import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import {
  SIGNED_URL_MS,
  START_SKEW_MS,
  addSeconds,
  errText,
  highestLimit,
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
 * ElevenLabs' conversation list is the source of truth for Web Voice
 * minutes. The usage doc carries a WATERMARK per agent id (`watermarks`):
 * every conversation of that agent that started before it has been counted.
 * Each sweep:
 *
 *   1. lists ALL the agent's conversations that started in
 *      [watermark − OVERLAP, now − ripe), where ripe = `maxCallSeconds` +
 *      2 min, so every call in range has ended. The overlap re-reads the
 *      last 10 minutes behind the watermark: a call ElevenLabs lists late, or
 *      one on the boundary second of an exclusive `call_start_after_unix`,
 *      is still seen. Calls counted before are in `settled` (or pending), so
 *      re-reading them never counts them twice;
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
 * duration, or is still running without being pending. One exception keeps a
 * single bad item from stalling metering forever: an item that is doubtful
 * for any reason but its start time, and started more than an hour before
 * the range ends, is counted at the highest call limit in force in the
 * window (`limitLog`, never below today's `maxCallSeconds`; fail closed on
 * money) and the sweep proceeds. A forced item without a usable id is
 * remembered under a synthetic key, so it is charged once. While a sweep is blocked the doc records
 * since when (`reconcileStalledSinceMs`) and how many sweeps it has blocked;
 * past 2 hours it logs an error on every blocked sweep.
 *
 * A refund needs positive evidence: a complete list, every item in range
 * well-formed. Lapsed grants of an agent other than the watermark's (a
 * re-key) are never refunded — that agent is not listed, so there is no
 * evidence either way.
 *
 * ASSUMED, not runtime-verified: the list endpoint's filters, fields and
 * paging (see `listConversations`); the contract test pins our reading.
 */

/** Pages of 100 read per sweep; more means doubt (nothing changes). */
const MAX_PAGES = 10;

const OPEN_STATUSES = new Set(["initiated", "in-progress", "processing"]);

type Doubt = { reason: string; count: number };

/** Re-read this far behind the watermark on every sweep (late indexing). */
const OVERLAP_MS = 10 * 60 * 1000;
/** A doubtful item older than this behind the range's end is counted in full. */
const DOUBT_GIVE_UP_MS = 60 * 60 * 1000;
/** Blocked longer than this, every blocked sweep logs an error. */
const STALL_ALARM_MS = 2 * 60 * 60 * 1000;

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

/** The id a counted item is remembered by in `settled`. An item with no
 *  usable id (only ever counted by giving up on it) gets a synthetic key, so
 *  it is charged once even if a later sweep's range still covers it. */
function dedupeKey(c: ConversationListItem, agentId: string): string {
  return c.conversationId ?? `nil:${(c.startTimeUnixSecs ?? 0) * 1000}:${agentId}`;
}

/** What is wrong with an in-range item, or null when it can be counted. */
function problemWith(c: ConversationListItem): string | null {
  if (c.conversationId === null) return "no conversation id";
  if (c.agentId === null) return "no agent id";
  if (c.status !== null && OPEN_STATUSES.has(c.status)) return "still running";
  if (c.status !== "failed" && c.durationSeconds === null) return "no duration";
  return null;
}

/** The calls in [lowMs, toMs) to count at their duration, those to count in
 *  full (doubtful but older than `giveUpBeforeMs`), or a doubt. `counted` =
 *  ids a claim or an earlier sweep already covers (pending or settled). */
function callsToCount(
  listed: ConversationListItem[],
  agentId: string,
  range: { lowMs: number; toMs: number; giveUpBeforeMs: number },
  counted: Set<string>,
): { calls: ConversationListItem[]; forced: ConversationListItem[] } | { doubt: Doubt } {
  const doubts = new Map<string, number>();
  const doubt = (reason: string) => doubts.set(reason, (doubts.get(reason) ?? 0) + 1);
  const calls: ConversationListItem[] = [];
  const forced: ConversationListItem[] = [];
  for (const c of listed) {
    if (c.agentId !== null && c.agentId !== agentId) continue; // another agent's: not ours
    if (c.startTimeUnixSecs === null) {
      doubt("no start time"); // cannot even tell whether it is in range
      continue;
    }
    const startMs = c.startTimeUnixSecs * 1000;
    if (startMs < range.lowMs || startMs >= range.toMs) continue;
    if (counted.has(dedupeKey(c, agentId))) continue;
    const problem = problemWith(c);
    if (problem === null) calls.push(c);
    else if (startMs < range.giveUpBeforeMs) forced.push(c);
    else doubt(problem);
  }
  if (doubts.size > 0) {
    const reason = [...doubts].map(([r, n]) => `${n} ${r}`).join(", ");
    return { doubt: { reason, count: [...doubts.values()].reduce((a, b) => a + b, 0) } };
  }
  return { calls, forced };
}

/** A call's real duration — a failed call too, when ElevenLabs reports one
 *  (as settling counts it); 0 only for a failed call with none. */
const secondsOf = (c: ConversationListItem) => Math.max(0, Math.round(c.durationSeconds ?? 0));

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
  const fromMs = own(before.watermarks, agentId);
  // No grant has been minted for this agent yet: there is nothing to count.
  if (fromMs === undefined) return;
  const now = Date.now();
  const ripeMs = conn.maxCallSeconds * 1000 + 2 * 60 * 1000;
  const toMs = Math.floor((now - ripeMs) / 1000) * 1000;
  if (toMs <= fromMs) return;
  const range = { lowMs: fromMs - OVERLAP_MS, toMs, giveUpBeforeMs: toMs - DOUBT_GIVE_UP_MS };

  const listed = await listSince(subAccountId, conn.apiKey, agentId, range.lowMs);
  if (!listed) return;

  const db = getAdminDb();
  const ref = db.doc(webVoiceUsagePath(subAccountId));
  await db.runTransaction(async (tx) => {
    const u = normalise((await tx.get(ref)).data() as Partial<WebVoiceUsageDoc> | undefined);
    if (own(u.watermarks, agentId) !== fromMs) return; // another sweep won
    const counted = new Set([...Object.keys(u.pending), ...u.settled]);
    const result = callsToCount(listed, agentId, range, counted);
    if ("doubt" in result) {
      // Nothing about money changes; only the stall is recorded.
      const since = u.reconcileStalledSinceMs ?? now;
      u.reconcileStalledSinceMs = since;
      u.reconcileStalledSweeps += 1;
      tx.set(ref, u);
      const message = `[web-voice] reconcile: ${result.doubt.count} doubtful conversation(s) sa=${subAccountId} (${result.doubt.reason}); nothing changed, blocked ${u.reconcileStalledSweeps} sweep(s) since ${new Date(since).toISOString()}`;
      if (now - since > STALL_ALARM_MS) console.error(message);
      else console.warn(message);
      return;
    }
    for (const c of result.calls) addSeconds(u, secondsOf(c));
    if (result.forced.length > 0) {
      // Never less than the limit the calls could have run under.
      const limit = highestLimit(u, range.lowMs - SIGNED_URL_MS, range.toMs, conn.maxCallSeconds);
      addSeconds(u, result.forced.length * limit);
      console.warn(
        `[web-voice] reconcile: ${result.forced.length} conversation(s) still doubtful after an hour sa=${subAccountId}; counted at ${limit} s each`,
      );
    }
    markSettled(u, [...result.calls, ...result.forced].map((c) => dedupeKey(c, agentId)));
    for (const [id, charge] of Object.entries(u.lapsed)) {
      const expiredBy = charge.issuedAtMs + SIGNED_URL_MS + START_SKEW_MS;
      if (expiredBy > toMs) continue;
      // Another agent's (a re-key): its calls are not on this list, so the
      // charge stands; the entry just stops being tracked.
      if (charge.agentId === agentId) refund(u, charge);
      delete u.lapsed[id];
    }
    u.watermarks[agentId] = toMs;
    u.reconcileStalledSinceMs = null;
    u.reconcileStalledSweeps = 0;
    tx.set(ref, u);
  });
}
