import "server-only";

import { createHash } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import type { CapabilityApproval } from "@/lib/ai-suite/capabilities";

/**
 * The Agent API approval queue (`agentProposals/{id}`). An agent call on a
 * capability with an `approval` class never executes: it lands here as a
 * `pending` row a person approves or rejects. Every transition is a
 * precondition transaction on the row's current status, so no sweep or
 * decision can clobber a row another path already moved. Spec:
 * AGENT_API_V1_PLAN.md "Approval queue" and "Approve path".
 */

export type ProposalStatus =
  | "pending"
  | "executing"
  | "executed"
  | "failed"
  | "rejected"
  | "expired"
  | "unsettled";

const TERMINAL: ProposalStatus[] = ["executed", "failed", "rejected", "expired"];
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** An `executing` row older than this lost its process mid-action. */
export const STALE_CLAIM_MS = 10 * 60 * 1000;
const SWEEP_LIMIT = 500;

export const OUTCOME_UNKNOWN_MESSAGE =
  "A previous approval of this exact action may have sent; check the conversation before re-proposing.";

export interface ProposalInput {
  agencyId: string;
  subAccountId: string;
  keyId: string;
  keyPrefix: string;
  capability: string;
  approval: CapabilityApproval;
  args: Record<string, unknown>;
  summary: string;
  preview: Array<{ label: string; value: string }>;
  /** workflow_enrolment rows only: one row per matched workflow. */
  workflowId?: string;
}

export type CreateProposalResult =
  | {
      ok: true;
      id: string;
      status: ProposalStatus;
      summary: string;
      preview: Array<{ label: string; value: string }>;
    }
  | { ok: false; code: "outcome_unknown"; id: string };

/** Key-sorted JSON, so the same args always hash the same. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

export function proposalId(input: ProposalInput): string {
  const key = [
    input.subAccountId,
    input.keyId,
    input.capability,
    canonical(input.args),
    input.workflowId ?? "",
  ].join("|");
  return `p_${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
}

/** Firestore Timestamp / Date → epoch ms (null when absent). */
export function millis(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  if (v && typeof (v as { toMillis?: unknown }).toMillis === "function") {
    return (v as { toMillis: () => number }).toMillis();
  }
  return null;
}

const proposalRef = (id: string) => getAdminDb().doc(`agentProposals/${id}`);
const historyRef = (id: string) => proposalRef(id).collection("history").doc();

/**
 * Dedupe is pending-only: a `pending` or `executing` row returns its id, an
 * `unsettled` row refuses (its action may already have happened), and a
 * terminal row moves to `history` so the id is re-used as a fresh `pending`.
 */
export async function createProposal(input: ProposalInput): Promise<CreateProposalResult> {
  const id = proposalId(input);
  const ref = proposalRef(id);
  return getAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.data();
    const status = cur?.status as ProposalStatus | undefined;
    if (status === "pending" || status === "executing") {
      return { ok: true, id, status, summary: cur!.summary, preview: cur!.preview };
    }
    if (status === "unsettled") return { ok: false, code: "outcome_unknown", id };
    if (status && TERMINAL.includes(status)) tx.set(historyRef(id), cur!);
    const now = Date.now();
    tx.set(ref, {
      agencyId: input.agencyId,
      subAccountId: input.subAccountId,
      createdByUid: `apikey:${input.keyPrefix}`,
      keyId: input.keyId,
      keyPrefix: input.keyPrefix,
      capability: input.capability,
      approval: input.approval,
      args: input.args,
      summary: input.summary,
      preview: input.preview,
      contactId: typeof input.args.contactId === "string" ? input.args.contactId : null,
      workflowId: input.workflowId ?? null,
      status: "pending",
      createdAt: new Date(now),
      expiresAt: new Date(now + TTL_MS),
      claimedAt: null,
      decidedAt: null,
      decidedByUid: null,
      decidedByEmail: null,
      result: null,
      error: null,
    });
    return { ok: true, id, status: "pending", summary: input.summary, preview: input.preview };
  });
}

/**
 * Move a row `from` → `patch.status` only when its status is still `from`
 * at read time (and, when given, its claim is still `claimedAtMs`).
 * Returns false when the row is absent or has moved on.
 */
export async function transitionIf(
  id: string,
  from: ProposalStatus,
  patch: Record<string, unknown> & { status: ProposalStatus },
  claimedAtMs?: number
): Promise<boolean> {
  const ref = proposalRef(id);
  return getAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.data();
    if (!cur || cur.status !== from) return false;
    if (claimedAtMs !== undefined && millis(cur.claimedAt) !== claimedAtMs) return false;
    tx.update(ref, patch);
    return true;
  });
}

/** The approve claim: `pending` → `executing`. Null when not claimable. */
export async function claimProposal(
  id: string,
  by: { uid: string; email: string }
): Promise<number | null> {
  const claimedAt = new Date();
  const claimed = await transitionIf(id, "pending", {
    status: "executing",
    claimedAt,
    decidedAt: claimedAt,
    decidedByUid: by.uid,
    decidedByEmail: by.email,
  });
  return claimed ? claimedAt.getTime() : null;
}

/**
 * Settle a claimed row and write its `aiSuiteActions` row in one
 * transaction. If the row is no longer ours (the sweep flipped it to
 * `unsettled`), the outcome goes to `history` and is logged — never lost.
 */
export async function settleProposal(
  id: string,
  claimedAtMs: number,
  outcome:
    | { status: "executed"; result: { resultText: string; ref: { kind: string; id: string } | null } }
    | { status: "failed"; error: string },
  audit: {
    agencyId: string;
    subAccountId: string;
    capability: string;
    args: Record<string, unknown>;
    summary: string;
    confirmedByUid: string;
    confirmedByEmail: string;
  }
): Promise<"settled" | "late"> {
  const db = getAdminDb();
  const ref = proposalRef(id);
  const fields =
    outcome.status === "executed"
      ? { status: outcome.status, result: outcome.result }
      : { status: outcome.status, error: outcome.error };
  const settled = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.data();
    const mine = cur?.status === "executing" && millis(cur.claimedAt) === claimedAtMs;
    if (mine) tx.update(ref, fields);
    else tx.set(historyRef(id), { lateSettle: true, claimedAt: new Date(claimedAtMs), ...fields });
    tx.set(db.collection("aiSuiteActions").doc(), {
      level: "sub-account",
      ...audit,
      status: outcome.status,
      resultRef: outcome.status === "executed" ? outcome.result.ref : null,
      error: outcome.status === "failed" ? outcome.error : null,
      agentProposalId: id,
      createdAt: FieldValue.serverTimestamp(),
    });
    return mine;
  });
  if (!settled) {
    console.error(`[agent-proposals] late settle of ${id} (${outcome.status}) recorded in history`);
  }
  return settled ? "settled" : "late";
}

/** Revoking a key rejects its still-pending rows (never an executing one). */
export async function sweepRevokedKeyProposals(input: {
  subAccountId: string;
  keyId: string;
}): Promise<number> {
  const snap = await getAdminDb()
    .collection("agentProposals")
    .where("keyId", "==", input.keyId)
    .where("status", "==", "pending")
    .get();
  let rejected = 0;
  for (const doc of snap.docs) {
    if (doc.data().subAccountId !== input.subAccountId) continue;
    const moved = await transitionIf(doc.id, "pending", {
      status: "rejected",
      reason: "key_revoked",
      decidedAt: new Date(),
    });
    if (moved) rejected++;
  }
  return rejected;
}

/**
 * Daily (api-cleanup): expire `pending` rows past `expiresAt`, and flip
 * `executing` rows claimed over STALE_CLAIM_MS ago to `unsettled`.
 */
export async function sweepAgentProposals(
  now: Date
): Promise<{ collection: string; deleted: number; hitCap: boolean }> {
  const db = getAdminDb();
  const [expiring, stale] = await Promise.all([
    db.collection("agentProposals")
      .where("status", "==", "pending")
      .where("expiresAt", "<", now)
      .limit(SWEEP_LIMIT)
      .get(),
    db.collection("agentProposals")
      .where("status", "==", "executing")
      .where("claimedAt", "<", new Date(now.getTime() - STALE_CLAIM_MS))
      .limit(SWEEP_LIMIT)
      .get(),
  ]);
  let moved = 0;
  for (const doc of expiring.docs) {
    if (await transitionIf(doc.id, "pending", { status: "expired", decidedAt: now })) moved++;
  }
  for (const doc of stale.docs) {
    const claimedAtMs = millis(doc.data().claimedAt) ?? undefined;
    if (await transitionIf(doc.id, "executing", { status: "unsettled" }, claimedAtMs)) moved++;
  }
  return {
    collection: "agentProposals",
    deleted: moved,
    hitCap: expiring.size >= SWEEP_LIMIT || stale.size >= SWEEP_LIMIT,
  };
}
