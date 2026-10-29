import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { aiIsConfigured, callAi } from "@/lib/comms/ai/openrouter";
import { getAgentProfile } from "@/lib/comms/ai/agent";
import { createTaskServerSide } from "@/lib/server/tasks-service";
import { sendPushForEvent } from "@/lib/push/send";
import { contactTerritoryId } from "@/lib/push/events";
import { readPipelines } from "@/lib/pipelines/server";
import { dealPipelineId, dealStage } from "@/lib/pipelines/stages";
import { isDocId } from "@/lib/server/doc-id";
import {
  STALE_DEALS_DEFAULT_DAILY_TOKEN_BUDGET,
  STALE_DEALS_DEFAULT_THRESHOLD_DAYS,
  STALE_DEALS_MAX_FLAGS_PER_RUN,
  WATCHDOG_DEFAULT_DAILY_TOKEN_BUDGET,
  WATCHDOG_DEFAULT_THRESHOLD_HOURS,
  WATCHDOG_MAX_JUDGMENTS_PER_RUN,
  agentDocId,
  type AgentConfigBase,
  type AgentType,
  type StaleDealsConfigDoc,
  type StaleDealsConfigResponse,
  type WatchdogConfigDoc,
  type WatchdogConfigResponse,
  type WatchdogQuietHours,
  type WatchdogRunAction,
  type WatchdogRunDoc,
  type WatchdogRunResponse,
  type WatchdogSkippedReason,
} from "@/types/custom-agents";
import type { ConversationChannel, ConversationDoc } from "@/types/conversations";
import type { Deal } from "@/types/deals";
import type { SubAccountDoc } from "@/types";
import { runAfterResponse } from "@/lib/server/after-response";

/**
 * Inbox Follow-up Watchdog — the Labs autonomous agent (Custom Agents v1).
 * Locked scope: CUSTOM_AGENTS_V1_PLAN.md.
 *
 * Safety invariants (do NOT relax without a new plan):
 *   1. Actions are additive-internal ONLY: create Task, push-notify the
 *      team, write an activity row, stamp the dedupe field. It can never
 *      message a customer or mutate a record.
 *   2. All reads are tenant-scoped: the sweep takes subAccountId from the
 *      agent doc's id, never from model output.
 *   3. LLM output is CLASSIFICATION, not tool choice — strict-JSON parse,
 *      clamped fields; unparseable → treated as "no follow-up needed".
 *   4. Cost bounds: deterministic pre-filter first; ≤20 judgments/run;
 *      per-day token budget; gates re-checked EVERY run.
 *
 * The Stale deals monitor (AI Agents → Monitors) shares the collection, the
 * hourly sweep and these invariants, except that RULES pick the deals and
 * the model only writes the one-line note. It is gated by
 * `agentsEnabledByAgency`; the watchdog keeps its Labs + AI Suite gates.
 */

const AGENTS_COLLECTION = "customAgents";
/** Pre-filter fetch size — shortlist is capped later at MAX_JUDGMENTS. */
const PREFILTER_FETCH_LIMIT = 60;
/** Thread excerpt: last N messages fed to the judge. */
const THREAD_EXCERPT_MESSAGES = 5;
const MAX_RUNS_KEPT_DAYS = 30;
const STALE_DEALS_FETCH_LIMIT = 200;
/** Pages of STALE_DEALS_FETCH_LIMIT scanned per run before giving up. */
const STALE_DEALS_MAX_PAGES = 5;
/** Candidate deals given the recent-work checks (3 reads each) per run. */
const STALE_DEALS_MAX_CHECKS_PER_RUN = 60;
/** Contact activity rows read per candidate deal when checking for recent work. */
const STALE_DEALS_ACTIVITY_LOOKBACK = 15;

function agentRef(subAccountId: string, type: AgentType = "inbox-watchdog") {
  return getAdminDb()
    .collection(AGENTS_COLLECTION)
    .doc(agentDocId(subAccountId, type));
}

// ---------------------------------------------------------------------------
// Config (used by the admin API route)
// ---------------------------------------------------------------------------

export function serializeWatchdogConfig(
  data: Partial<WatchdogConfigDoc> | undefined,
): WatchdogConfigResponse {
  return {
    enabled: data?.enabled === true,
    thresholdHours:
      typeof data?.thresholdHours === "number"
        ? data.thresholdHours
        : WATCHDOG_DEFAULT_THRESHOLD_HOURS,
    instructions: data?.instructions ?? null,
    quietHours: data?.quietHours ?? null,
    dailyTokenBudget:
      typeof data?.dailyTokenBudget === "number"
        ? data.dailyTokenBudget
        : WATCHDOG_DEFAULT_DAILY_TOKEN_BUDGET,
    totalTokensUsed:
      typeof data?.totalTokensUsed === "number" ? data.totalTokensUsed : 0,
  };
}

export async function getWatchdogConfig(
  subAccountId: string,
): Promise<WatchdogConfigResponse> {
  const snap = await agentRef(subAccountId).get();
  return serializeWatchdogConfig(snap.data() as Partial<WatchdogConfigDoc>);
}

export async function upsertWatchdogConfig(
  subAccountId: string,
  agencyId: string,
  patch: Partial<
    Pick<
      WatchdogConfigDoc,
      "enabled" | "thresholdHours" | "instructions" | "quietHours"
    >
  >,
): Promise<WatchdogConfigResponse> {
  const ref = agentRef(subAccountId);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({
      subAccountId,
      agencyId,
      enabled: false,
      thresholdHours: WATCHDOG_DEFAULT_THRESHOLD_HOURS,
      instructions: null,
      quietHours: null,
      dailyTokenBudget: WATCHDOG_DEFAULT_DAILY_TOKEN_BUDGET,
      tokensTodayDate: null,
      tokensToday: 0,
      totalTokensUsed: 0,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    } satisfies Omit<WatchdogConfigDoc, "createdAt" | "updatedAt"> & {
      createdAt: FieldValue;
      updatedAt: FieldValue;
    });
  }
  await ref.update({ ...patch, updatedAt: FieldValue.serverTimestamp() });
  const updated = await ref.get();
  return serializeWatchdogConfig(updated.data() as Partial<WatchdogConfigDoc>);
}

export function serializeStaleDealsConfig(
  data: Partial<StaleDealsConfigDoc> | undefined,
): StaleDealsConfigResponse {
  return {
    enabled: data?.enabled === true,
    thresholdDays:
      typeof data?.thresholdDays === "number"
        ? data.thresholdDays
        : STALE_DEALS_DEFAULT_THRESHOLD_DAYS,
    pipelineIds: Array.isArray(data?.pipelineIds) ? data.pipelineIds : null,
    excludeStageKeys: Array.isArray(data?.excludeStageKeys)
      ? data.excludeStageKeys
      : [],
    instructions: data?.instructions ?? null,
    quietHours: data?.quietHours ?? null,
    dailyTokenBudget:
      typeof data?.dailyTokenBudget === "number"
        ? data.dailyTokenBudget
        : STALE_DEALS_DEFAULT_DAILY_TOKEN_BUDGET,
    totalTokensUsed:
      typeof data?.totalTokensUsed === "number" ? data.totalTokensUsed : 0,
  };
}

export async function getStaleDealsConfig(
  subAccountId: string,
): Promise<StaleDealsConfigResponse> {
  const snap = await agentRef(subAccountId, "stale-deals").get();
  return serializeStaleDealsConfig(snap.data() as Partial<StaleDealsConfigDoc>);
}

export async function upsertStaleDealsConfig(
  subAccountId: string,
  agencyId: string,
  patch: Partial<
    Pick<
      StaleDealsConfigDoc,
      | "enabled"
      | "thresholdDays"
      | "pipelineIds"
      | "excludeStageKeys"
      | "instructions"
      | "quietHours"
    >
  >,
): Promise<StaleDealsConfigResponse> {
  const ref = agentRef(subAccountId, "stale-deals");
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set({
      subAccountId,
      agencyId,
      type: "stale-deals",
      enabled: false,
      thresholdDays: STALE_DEALS_DEFAULT_THRESHOLD_DAYS,
      pipelineIds: null,
      excludeStageKeys: [],
      instructions: null,
      quietHours: null,
      dailyTokenBudget: STALE_DEALS_DEFAULT_DAILY_TOKEN_BUDGET,
      tokensTodayDate: null,
      tokensToday: 0,
      totalTokensUsed: 0,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    } satisfies Omit<StaleDealsConfigDoc, "createdAt" | "updatedAt"> & {
      createdAt: FieldValue;
      updatedAt: FieldValue;
    });
  }
  await ref.update({ ...patch, updatedAt: FieldValue.serverTimestamp() });
  const updated = await ref.get();
  return serializeStaleDealsConfig(
    updated.data() as Partial<StaleDealsConfigDoc>,
  );
}

function tsToIso(value: unknown): string | null {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return null;
}

export function listWatchdogRuns(
  subAccountId: string,
  limit = 10,
): Promise<WatchdogRunResponse[]> {
  return listAgentRuns(subAccountId, "inbox-watchdog", limit);
}

export async function listAgentRuns(
  subAccountId: string,
  type: AgentType,
  limit = 10,
): Promise<WatchdogRunResponse[]> {
  const snap = await agentRef(subAccountId, type)
    .collection("runs")
    .orderBy("startedAt", "desc")
    .limit(limit)
    .get();
  return snap.docs.map((d) => {
    const data = d.data() as WatchdogRunDoc;
    return {
      id: d.id,
      status: data.status,
      skippedReason: data.skippedReason ?? null,
      scanned: data.scanned ?? 0,
      judged: data.judged ?? 0,
      flagged: data.flagged ?? 0,
      actions: data.actions ?? [],
      tokensUsed: data.tokensUsed ?? 0,
      startedAt: tsToIso(data.startedAt),
      finishedAt: tsToIso(data.finishedAt),
    };
  });
}

// ---------------------------------------------------------------------------
// The hourly sweep
// ---------------------------------------------------------------------------

const CHANNEL_COLLECTION: Partial<Record<ConversationChannel, string>> = {
  sms: "messages",
  whatsapp: "whatsappMessages",
  messenger: "metaMessages",
  instagram: "metaMessages",
  // Web-chat transcripts don't live under a contact; watchdog candidates are
  // filtered to exclude web-chat before this map is consulted (see below), so
  // this fallback is never actually read.
  "web-chat": "messages",
};

interface JudgeVerdict {
  needsFollowUp: boolean;
  urgency: "high" | "normal";
  reason: string;
}

/** Strict-JSON parse of the judge output. Anything unparseable → null
 *  (treated as "no follow-up") so a rambling model can't force an alert. */
function parseVerdict(text: string): JudgeVerdict | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[0]) as Record<string, unknown>;
    if (typeof raw.needsFollowUp !== "boolean") return null;
    return {
      needsFollowUp: raw.needsFollowUp,
      urgency: raw.urgency === "high" ? "high" : "normal",
      reason:
        typeof raw.reason === "string"
          ? raw.reason.trim().slice(0, 140)
          : "Unanswered inbound conversation",
    };
  } catch {
    return null;
  }
}

/** Local hour in a timezone (defensive — falls back to UTC). */
function hourInTz(timezone: string, at: Date): number {
  try {
    const part = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: timezone || "UTC",
    })
      .formatToParts(at)
      .find((p) => p.type === "hour");
    const hour = part ? Number(part.value) : at.getUTCHours();
    if (!Number.isFinite(hour)) return at.getUTCHours();
    return hour === 24 ? 0 : hour;
  } catch {
    return at.getUTCHours();
  }
}

/** True when `at` falls inside the quiet window (push suppressed). */
export function isInQuietHours(
  quiet: WatchdogQuietHours | null,
  at: Date,
): boolean {
  if (!quiet) return false;
  const hour = hourInTz(quiet.timezone, at);
  const { startHour, endHour } = quiet;
  if (startHour === endHour) return false; // degenerate window = off
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour; // overnight window
}

function toMillis(value: unknown): number | null {
  if (value instanceof Timestamp) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return null;
}

async function loadThreadExcerpt(
  contactId: string,
  channel: ConversationChannel,
  nowMs: number,
): Promise<string> {
  if (channel === "email") return ""; // Mailbox imports do not enroll automated follow-up.
  const collection = CHANNEL_COLLECTION[channel] ?? "messages";
  const snap = await getAdminDb()
    .collection("contacts")
    .doc(contactId)
    .collection(collection)
    .orderBy("createdAt", "desc")
    .limit(THREAD_EXCERPT_MESSAGES)
    .get();
  const lines = snap.docs.reverse().map((d) => {
    const data = d.data() as {
      direction?: string;
      body?: string;
      createdAt?: unknown;
    };
    const ageMs = nowMs - (toMillis(data.createdAt) ?? nowMs);
    const ageH = Math.max(0, Math.round(ageMs / 3_600_000));
    const who = data.direction === "outbound" ? "BUSINESS" : "CUSTOMER";
    const body = (data.body ?? "").replace(/\s+/g, " ").slice(0, 300);
    return `[${who}, ${ageH}h ago] ${body}`;
  });
  return lines.join("\n") || "(no readable messages)";
}

interface SweepAccountResult {
  subAccountId: string;
  status: WatchdogRunDoc["status"];
  skippedReason: WatchdogSkippedReason | null;
  scanned: number;
  judged: number;
  flagged: number;
  tokensUsed: number;
}

/** Run the watchdog for ONE sub-account. Never throws — failures land in
 *  the run doc. */
async function runWatchdogForSubAccount(
  agent: WatchdogConfigDoc & { subAccountId: string },
): Promise<SweepAccountResult> {
  const db = getAdminDb();
  const subAccountId = agent.subAccountId;
  const runRef = agentRef(subAccountId).collection("runs").doc();
  const now = new Date();
  const nowMs = now.getTime();

  const base: Omit<WatchdogRunDoc, "status" | "skippedReason"> = {
    scanned: 0,
    droppedByCap: 0,
    judged: 0,
    flagged: 0,
    actions: [],
    tokensUsed: 0,
    error: null,
    startedAt: FieldValue.serverTimestamp(),
    finishedAt: FieldValue.serverTimestamp(),
  };

  const skip = async (
    reason: WatchdogSkippedReason,
  ): Promise<SweepAccountResult> => {
    await runRef.set({ ...base, status: "skipped", skippedReason: reason });
    return {
      subAccountId,
      status: "skipped",
      skippedReason: reason,
      scanned: 0,
      judged: 0,
      flagged: 0,
      tokensUsed: 0,
    };
  };

  try {
    // ── Guards (re-checked EVERY run so agency flips take effect ≤1h) ──
    const saSnap = await db.doc(`subAccounts/${subAccountId}`).get();
    const sub = saSnap.exists ? (saSnap.data() as SubAccountDoc) : null;
    if (!sub || sub.labsEnabledByAgency !== true) return skip("labs_gate_off");
    if (sub.aiSuiteEnabledByAgency !== true) return skip("ai_gate_off");
    if (!aiIsConfigured()) return skip("ai_not_configured");

    // Daily token budget (UTC day).
    const today = now.toISOString().slice(0, 10);
    const tokensToday =
      agent.tokensTodayDate === today ? (agent.tokensToday ?? 0) : 0;
    const budget = agent.dailyTokenBudget ?? WATCHDOG_DEFAULT_DAILY_TOKEN_BUDGET;
    if (tokensToday >= budget) return skip("budget_exceeded");

    // ── Deterministic pre-filter ────────────────────────────────────────
    const thresholdHours =
      agent.thresholdHours ?? WATCHDOG_DEFAULT_THRESHOLD_HOURS;
    const cutoff = Timestamp.fromMillis(nowMs - thresholdHours * 3_600_000);
    const convSnap = await db
      .collection("conversations")
      .where("subAccountId", "==", subAccountId)
      .where("lastDirection", "==", "inbound")
      .where("lastMessageAt", "<=", cutoff)
      .orderBy("lastMessageAt", "asc")
      .limit(PREFILTER_FETCH_LIMIT)
      .get();

    const candidates = convSnap.docs
      .map((d) => ({ id: d.id, ...(d.data() as Omit<ConversationDoc, "id">) }))
      // Follow-up needs a contact to create a Task against, and web-chat has
      // its own operator console — so the watchdog only ever considers
      // contact-backed, non-web-chat threads. Every pre-existing conversation
      // has a contactId, so this is a no-op for them.
      .filter((c) => !!c.contactId && c.lastChannel !== "web-chat" && c.lastChannel !== "email")
      .filter((c) => c.status !== "closed" && c.status !== "snoozed")
      .filter((c) => {
        // Dedupe: skip when we already alerted for the CURRENT last message.
        // A newer inbound moves lastMessageAt past the stamp → re-arms.
        const alerted = toMillis(
          (c as unknown as { watchdogAlertedAt?: unknown }).watchdogAlertedAt,
        );
        const last = toMillis(c.lastMessageAt);
        return !(alerted !== null && last !== null && alerted >= last);
      });

    const scanned = candidates.length;
    const shortlist = candidates.slice(0, WATCHDOG_MAX_JUDGMENTS_PER_RUN);
    const droppedByCap = scanned - shortlist.length;

    if (shortlist.length === 0) {
      await runRef.set({
        ...base,
        scanned,
        droppedByCap,
        status: "completed",
        skippedReason: null,
      });
      return {
        subAccountId,
        status: "completed",
        skippedReason: null,
        scanned,
        judged: 0,
        flagged: 0,
        tokensUsed: 0,
      };
    }

    // ── LLM judge per shortlisted conversation ──────────────────────────
    const profile = await getAgentProfile(subAccountId).catch(() => null);
    const businessName =
      profile?.businessName?.trim() || sub.name || "the business";
    const quiet = agent.quietHours ?? null;
    const pushSuppressed = isInQuietHours(quiet, now);

    let judged = 0;
    let tokensUsed = 0;
    const actions: WatchdogRunAction[] = [];

    for (const conv of shortlist) {
      if (tokensToday + tokensUsed >= budget) break;
      // Belt-and-braces: candidates were already filtered to contact-backed
      // rows, but this also narrows contactId to string for the loop body.
      if (!conv.contactId) continue;

      const excerpt = await loadThreadExcerpt(
        conv.contactId,
        conv.lastChannel ?? "sms",
        nowMs,
      );
      const hoursWaiting = Math.max(
        1,
        Math.round((nowMs - (toMillis(conv.lastMessageAt) ?? nowMs)) / 3_600_000),
      );

      const systemPrompt = [
        `You triage unanswered inbound conversations for ${businessName}.`,
        `The customer's last message has been waiting ${hoursWaiting} hours with no reply from the business.`,
        `Decide whether a human should follow up NOW. Flag conversations where the customer asked a question, showed buying intent, raised a problem, or expects a reply. Do NOT flag pure pleasantries, closed loops ("thanks, bye"), spam, or automated notifications.`,
        agent.instructions?.trim()
          ? `Operator criteria (weigh heavily): ${agent.instructions.trim()}`
          : "",
        `Respond with ONLY this JSON, nothing else:`,
        `{"needsFollowUp": true|false, "urgency": "high"|"normal", "reason": "<one line, max 140 chars, written for the business owner>"}`,
      ]
        .filter(Boolean)
        .join("\n");

      let verdict: JudgeVerdict | null = null;
      try {
        const completion = await callAi({
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: `Conversation with ${conv.contactName || "a contact"}:\n${excerpt}`,
            },
          ],
          maxTokens: 120,
          temperature: 0.2,
        });
        judged++;
        tokensUsed += completion.totalTokens;
        verdict = parseVerdict(completion.text);
      } catch (err) {
        // One failed judgment shouldn't kill the sweep — log and move on.
        console.warn(
          `[watchdog] judge failed sa=${subAccountId} contact=${conv.contactId}`,
          err instanceof Error ? err.message : err,
        );
        continue;
      }

      if (!verdict?.needsFollowUp) continue;

      // ── Act: Task + push + activity + dedupe stamp (additive only) ────
      const contactName = conv.contactName || "a contact";
      try {
        const task = await createTaskServerSide({
          subAccountId,
          agencyId: conv.agencyId,
          createdByUid: "ai-watchdog",
          mode: "live",
          title: `Follow up with ${contactName} — ${verdict.reason}`.slice(0, 200),
          notes: [
            `Flagged by the Inbox Follow-up Watchdog (Labs).`,
            `Waiting: ~${hoursWaiting}h since the customer's last message.`,
            `Urgency: ${verdict.urgency}.`,
            `Open the conversation: /sa/${subAccountId}/conversations/${conv.contactId}`,
          ].join("\n"),
          dueAt: now,
          contactId: conv.contactId,
          dealId: null,
          eventId: null,
        });

        if (!pushSuppressed) {
          // The push names the contact, so it follows the contact's
          // territory like every other contact-keyed push. If that read
          // fails, no push (never an unscoped one); the sweep carries on.
          const pushContactId = conv.contactId;
          runAfterResponse(() => contactTerritoryId(pushContactId)
            .then((territoryId) =>
              sendPushForEvent({
                subAccountId,
                agencyId: conv.agencyId,
                title: `⏰ Follow-up needed: ${contactName}`,
                body: verdict.reason,
                url: `/sa/${subAccountId}/conversations/${pushContactId}`,
                tag: `watchdog-${pushContactId}`,
                territoryId,
              }),
            )
            .catch((err) =>
              console.warn("[watchdog] territory read failed; push skipped", err),
            ));
        }

        // Activity row — best-effort, never blocks the sweep.
        const activityContactId = conv.contactId;
        runAfterResponse(() => db.collection("contacts")
          .doc(activityContactId)
          .collection("activities")
          .add({
            type: "ai_agent_flagged",
            content: `Watchdog flagged this conversation for follow-up (${verdict.urgency}): ${verdict.reason}`,
            meta: { taskId: task.id, hoursWaiting },
            agencyId: conv.agencyId,
            subAccountId,
            createdBy: "ai-watchdog",
            createdAt: FieldValue.serverTimestamp(),
          })
          .catch((err) =>
            console.warn("[watchdog] activity write failed", err),
          ));

        // Dedupe stamp — one alert per inbound message, self-re-arming.
        await db.doc(`conversations/${conv.id}`).update({
          watchdogAlertedAt: FieldValue.serverTimestamp(),
        });

        actions.push({
          contactId: conv.contactId,
          contactName,
          taskId: task.id,
          reason: verdict.reason,
          urgency: verdict.urgency,
        });
      } catch (err) {
        console.error(
          `[watchdog] act failed sa=${subAccountId} contact=${conv.contactId}`,
          err,
        );
      }
    }

    // ── Record ──────────────────────────────────────────────────────────
    await runRef.set({
      ...base,
      scanned,
      droppedByCap,
      judged,
      flagged: actions.length,
      actions,
      tokensUsed,
      status: "completed",
      skippedReason: null,
    });
    await agentRef(subAccountId).update({
      tokensTodayDate: today,
      tokensToday: tokensToday + tokensUsed,
      totalTokensUsed: FieldValue.increment(tokensUsed),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      subAccountId,
      status: "completed",
      skippedReason: null,
      scanned,
      judged,
      flagged: actions.length,
      tokensUsed,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error(`[watchdog] run failed sa=${subAccountId}:`, err);
    await runRef
      .set({
        ...base,
        status: "failed",
        skippedReason: null,
        error: msg.slice(0, 500),
      })
      .catch(() => undefined);
    return {
      subAccountId,
      status: "failed",
      skippedReason: null,
      scanned: 0,
      judged: 0,
      flagged: 0,
      tokensUsed: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Stale deals monitor
// ---------------------------------------------------------------------------

type DealRow = Deal & { mode?: unknown };

/** Someone is already on it: an open task for the deal, a message either way
 *  within the window, or deal activity on the contact within the window. */
async function dealHasRecentWork(
  deal: DealRow,
  contactId: string | null,
  cutoffMs: number,
): Promise<boolean> {
  const db = getAdminDb();

  const openTask = await db
    .collection("tasks")
    .where("subAccountId", "==", deal.subAccountId)
    .where("dealId", "==", deal.id)
    .where("completed", "==", false)
    .limit(1)
    .get();
  if (!openTask.empty) return true;

  if (contactId) {
    // Conversation doc id == contactId.
    const conv = await db.doc(`conversations/${contactId}`).get();
    const last = toMillis(conv.data()?.lastMessageAt);
    if (last !== null && last >= cutoffMs) return true;

    const acts = await db
      .collection("contacts")
      .doc(contactId)
      .collection("activities")
      .orderBy("createdAt", "desc")
      .limit(STALE_DEALS_ACTIVITY_LOOKBACK)
      .get();
    for (const a of acts.docs) {
      const data = a.data() as { meta?: { dealId?: string }; createdAt?: unknown };
      const at = toMillis(data.createdAt);
      if (at === null || at < cutoffMs) break;
      if (data.meta?.dealId === deal.id) return true;
    }
  }
  return false;
}

/** Already alerted for the current stage visit. A stage change writes a newer
 *  `stageChangedAt` than the stamp, which re-arms the deal. */
function alertedThisVisit(data: {
  staleAlertedAt?: unknown;
  stageChangedAt?: unknown;
}): boolean {
  const alerted = toMillis(data.staleAlertedAt);
  const changed = toMillis(data.stageChangedAt);
  return alerted !== null && changed !== null && alerted >= changed;
}

/**
 * Claim this stage visit before acting, inside a transaction that re-reads
 * the deal: false when it moved stage since the query (that is a new visit)
 * or another run already claimed it. One alert per visit, even when two
 * sweeps overlap; a claim is never released.
 */
async function claimStaleVisit(deal: DealRow): Promise<boolean> {
  const db = getAdminDb();
  const ref = db.doc(`deals/${deal.id}`);
  const seenChangedAt = toMillis(deal.stageChangedAt);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.data();
    if (!snap.exists || !data) return false;
    if (toMillis(data.stageChangedAt) !== seenChangedAt) return false;
    if (alertedThisVisit(data)) return false;
    tx.update(ref, { staleAlertedAt: FieldValue.serverTimestamp() });
    return true;
  });
}

/** Run the stale deals monitor for ONE sub-account. Never throws; failures
 *  land in the run doc. */
async function runStaleDealsForSubAccount(
  agent: StaleDealsConfigDoc,
): Promise<SweepAccountResult> {
  const db = getAdminDb();
  const subAccountId = agent.subAccountId;
  const runRef = agentRef(subAccountId, "stale-deals").collection("runs").doc();
  const now = new Date();
  const nowMs = now.getTime();

  const base: Omit<WatchdogRunDoc, "status" | "skippedReason"> = {
    scanned: 0,
    droppedByCap: 0,
    judged: 0,
    flagged: 0,
    actions: [],
    tokensUsed: 0,
    error: null,
    startedAt: FieldValue.serverTimestamp(),
    finishedAt: FieldValue.serverTimestamp(),
  };

  const skip = async (
    reason: WatchdogSkippedReason,
  ): Promise<SweepAccountResult> => {
    await runRef.set({ ...base, status: "skipped", skippedReason: reason });
    return {
      subAccountId,
      status: "skipped",
      skippedReason: reason,
      scanned: 0,
      judged: 0,
      flagged: 0,
      tokensUsed: 0,
    };
  };

  try {
    // Re-checked every run so an agency flip takes effect within the hour.
    const saSnap = await db.doc(`subAccounts/${subAccountId}`).get();
    const sub = saSnap.exists ? (saSnap.data() as SubAccountDoc) : null;
    if (!sub || sub.agentsEnabledByAgency !== true) return skip("agents_gate_off");
    if (!aiIsConfigured()) return skip("ai_not_configured");

    // Rules decide what gets flagged; the model only writes the note, so a
    // spent budget degrades to a templated note and the Task still lands.
    const today = now.toISOString().slice(0, 10);
    const tokensToday =
      agent.tokensTodayDate === today ? (agent.tokensToday ?? 0) : 0;
    const budget =
      agent.dailyTokenBudget ?? STALE_DEALS_DEFAULT_DAILY_TOKEN_BUDGET;

    const thresholdDays =
      agent.thresholdDays ?? STALE_DEALS_DEFAULT_THRESHOLD_DAYS;
    const cutoffMs = nowMs - thresholdDays * 24 * 3_600_000;
    const cutoff = Timestamp.fromMillis(cutoffMs);

    // Read-only: a sweep never seeds the default pipeline.
    const pipelines = await readPipelines(subAccountId);
    const allowedPipelines = Array.isArray(agent.pipelineIds)
      ? new Set(agent.pipelineIds)
      : null;
    const excluded = new Set(agent.excludeStageKeys ?? []);

    // Already-alerted deals stay inside the query window (the stamp only
    // re-arms on a stage change), so page past them instead of letting the
    // oldest stamped deals crowd out newer stale ones. `mode` is filtered in
    // memory: form and quote deals carry no `mode` and are live, which an
    // equality filter would drop.
    const rows: DealRow[] = [];
    let cursor: FirebaseFirestore.QueryDocumentSnapshot | null = null;
    for (let page = 0; page < STALE_DEALS_MAX_PAGES; page++) {
      let q = db
        .collection("deals")
        .where("subAccountId", "==", subAccountId)
        .where("stageChangedAt", "<=", cutoff)
        .orderBy("stageChangedAt", "asc")
        .limit(STALE_DEALS_FETCH_LIMIT);
      if (cursor) q = q.startAfter(cursor);
      const snap = await q.get();
      for (const d of snap.docs) {
        rows.push({ id: d.id, ...(d.data() as Omit<DealRow, "id">) });
      }
      if (snap.size < STALE_DEALS_FETCH_LIMIT) break;
      cursor = snap.docs[snap.docs.length - 1];
    }

    const candidates = rows.filter((deal) => {
      if (deal.mode === "test") return false;
      const pipelineId = dealPipelineId(deal);
      if (allowedPipelines && !allowedPipelines.has(pipelineId)) return false;
      if (excluded.has(`${pipelineId}:${deal.stageId}`)) return false;
      // Terminal per the deal's OWN pipeline. A stage we can't resolve
      // (deleted pipeline or stage) is never flagged either.
      const stage = dealStage(deal, pipelines);
      if (!stage || stage.terminal) return false;
      return !alertedThisVisit(deal);
    });

    const scanned = candidates.length;
    const quiet = agent.quietHours ?? null;
    const pushSuppressed = isInQuietHours(quiet, now);
    const businessName = sub.name || "the business";

    let judged = 0;
    let tokensUsed = 0;
    const actions: WatchdogRunAction[] = [];
    let droppedByCap = 0;
    let checked = 0;

    for (const deal of candidates) {
      // Both caps bound the per-run Firestore reads; whatever is left is
      // picked up next hour since nothing here changes the candidate set.
      if (
        actions.length >= STALE_DEALS_MAX_FLAGS_PER_RUN ||
        checked >= STALE_DEALS_MAX_CHECKS_PER_RUN
      ) {
        droppedByCap++;
        continue;
      }
      checked++;
      const contactId = isDocId(deal.contactId) ? deal.contactId : null;

      try {
        if (await dealHasRecentWork(deal, contactId, cutoffMs)) continue;
        if (!(await claimStaleVisit(deal))) continue;

        const stageLabel = dealStage(deal, pipelines)?.label ?? deal.stageId;
        const daysInStage = Math.max(
          1,
          Math.round((nowMs - (toMillis(deal.stageChangedAt) ?? nowMs)) / 86_400_000),
        );
        const contactSnap = contactId
          ? await db.doc(`contacts/${contactId}`).get()
          : null;
        const contactName =
          (contactSnap?.data()?.name as string | undefined)?.trim() || "the contact";

        // One short note; a failure or a spent budget keeps the template.
        let note = `No task, message or activity on this deal in ${thresholdDays} days.`;
        if (tokensToday + tokensUsed < budget) {
          try {
            const completion = await callAi({
              messages: [
                {
                  role: "system",
                  content: [
                    `You help the sales team at ${businessName} revive stalled deals.`,
                    `Write ONE sentence (max 140 characters) suggesting the next step for the team. Plain text, no quotes, no preamble.`,
                    agent.instructions?.trim()
                      ? `Operator guidance: ${agent.instructions.trim()}`
                      : "",
                  ]
                    .filter(Boolean)
                    .join("\n"),
                },
                {
                  role: "user",
                  content: `Deal "${deal.title}" (${deal.currency} ${deal.value}) with ${contactName} has sat in stage "${stageLabel}" for ${daysInStage} days with no task, message or activity.`,
                },
              ],
              maxTokens: 80,
              temperature: 0.4,
            });
            judged++;
            tokensUsed += completion.totalTokens;
            const text = completion.text.replace(/\s+/g, " ").trim();
            if (text) note = text.slice(0, 140);
          } catch (err) {
            console.warn(
              `[stale-deals] note failed sa=${subAccountId} deal=${deal.id}`,
              err instanceof Error ? err.message : String(err),
            );
          }
        }

        // ── Act: Task + push + activity (additive only; stamp claimed above)
        const task = await createTaskServerSide({
          subAccountId,
          agencyId: deal.agencyId,
          createdByUid: "ai-monitor",
          mode: "live",
          title: `Follow up: ${deal.title} — ${daysInStage} days in ${stageLabel}`.slice(0, 200),
          notes: [
            `Flagged by the Stale deals monitor.`,
            `Suggested next step: ${note}`,
            `Open the deal: /sa/${subAccountId}/pipeline`,
          ].join("\n"),
          dueAt: now,
          contactId,
          dealId: deal.id,
          eventId: null,
        });

        if (!pushSuppressed) {
          // The push names the deal, so it follows the deal's territory; a
          // legacy untagged deal reaches admins only.
          const territoryId =
            typeof deal.territoryId === "string" ? deal.territoryId : null;
          runAfterResponse(() => sendPushForEvent({
            subAccountId,
            agencyId: deal.agencyId,
            title: `📌 Stalled deal: ${deal.title}`,
            body: `${daysInStage} days in ${stageLabel}. ${note}`.slice(0, 160),
            url: `/sa/${subAccountId}/pipeline`,
            tag: `stale-deal-${deal.id}`,
            territoryId,
          }));
        }

        if (contactId) {
          runAfterResponse(() => db.collection("contacts")
            .doc(contactId)
            .collection("activities")
            .add({
              type: "ai_agent_flagged",
              content: `Stale deals monitor flagged "${deal.title}" (${daysInStage} days in ${stageLabel}): ${note}`,
              meta: { taskId: task.id, dealId: deal.id, daysInStage },
              agencyId: deal.agencyId,
              subAccountId,
              createdBy: "ai-monitor",
              createdAt: FieldValue.serverTimestamp(),
            })
            .catch((err) =>
              console.warn(
                "[stale-deals] activity write failed",
                err instanceof Error ? err.message : String(err),
              ),
            ));
        }

        actions.push({
          contactId: contactId ?? "",
          contactName,
          taskId: task.id,
          reason: note,
          urgency: "normal",
          dealId: deal.id,
          dealTitle: deal.title,
        });
      } catch (err) {
        console.error(
          `[stale-deals] act failed sa=${subAccountId} deal=${deal.id}`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    await runRef.set({
      ...base,
      scanned,
      droppedByCap,
      judged,
      flagged: actions.length,
      actions,
      tokensUsed,
      status: "completed",
      skippedReason: null,
    });
    await agentRef(subAccountId, "stale-deals").update({
      tokensTodayDate: today,
      tokensToday: tokensToday + tokensUsed,
      totalTokensUsed: FieldValue.increment(tokensUsed),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      subAccountId,
      status: "completed",
      skippedReason: null,
      scanned,
      judged,
      flagged: actions.length,
      tokensUsed,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error(`[stale-deals] run failed sa=${subAccountId}:`, msg);
    await runRef
      .set({
        ...base,
        status: "failed",
        skippedReason: null,
        error: msg.slice(0, 500),
      })
      .catch(() => undefined);
    return {
      subAccountId,
      status: "failed",
      skippedReason: null,
      scanned: 0,
      judged: 0,
      flagged: 0,
      tokensUsed: 0,
    };
  }
}

/** The hourly cron entry point: run every enabled agent, sequentially
 *  (fleet sizes are small; sequential keeps the invocation bounded and the
 *  Firestore load smooth), dispatched by `type` (absent = the watchdog). */
export async function runWatchdogSweep(): Promise<{
  agents: number;
  results: (SweepAccountResult & { type: AgentType })[];
}> {
  const snap = await getAdminDb()
    .collection(AGENTS_COLLECTION)
    .where("enabled", "==", true)
    .limit(200)
    .get();

  const results: (SweepAccountResult & { type: AgentType })[] = [];
  for (const doc of snap.docs) {
    const data = doc.data() as Partial<AgentConfigBase>;
    if (data.type === "stale-deals") {
      // Newer agent docs carry their sub-account; the doc id must agree, so
      // a doc can only ever sweep the sub-account it is named for.
      const subAccountId = data.subAccountId;
      if (
        !isDocId(subAccountId) ||
        doc.id !== agentDocId(subAccountId, "stale-deals")
      ) {
        console.warn(`[stale-deals] agent doc ${doc.id} skipped: subAccountId mismatch`);
        continue;
      }
      results.push({
        ...(await runStaleDealsForSubAccount({
          ...(data as StaleDealsConfigDoc),
          subAccountId,
        })),
        type: "stale-deals",
      });
      continue;
    }
    const agent = {
      ...(doc.data() as WatchdogConfigDoc),
      subAccountId: doc.id,
    };
    results.push({
      ...(await runWatchdogForSubAccount(agent)),
      type: "inbox-watchdog",
    });
  }
  return { agents: snap.size, results };
}

/** 30-day retention sweep for run logs — called from the daily cleanup cron. */
export async function sweepOldWatchdogRuns(): Promise<number> {
  const db = getAdminDb();
  const cutoff = Timestamp.fromMillis(
    Date.now() - MAX_RUNS_KEPT_DAYS * 24 * 3_600_000,
  );
  const agents = await db.collection(AGENTS_COLLECTION).limit(500).get();
  let deleted = 0;
  for (const agent of agents.docs) {
    const old = await agent.ref
      .collection("runs")
      .where("startedAt", "<", cutoff)
      .limit(200)
      .get();
    if (old.empty) continue;
    const batch = db.batch();
    for (const doc of old.docs) batch.delete(doc.ref);
    await batch.commit();
    deleted += old.size;
  }
  return deleted;
}
