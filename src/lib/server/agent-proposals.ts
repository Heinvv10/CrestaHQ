import "server-only";

import { createHash, randomBytes } from "node:crypto";
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
  /** The contact the action targets, for the approver's territory gate. */
  contactId: string | null;
}

export type CreateProposalResult =
  | {
      ok: true;
      id: string;
      status: ProposalStatus;
      rev: string;
      summary: string;
      preview: Array<{ label: string; value: string }>;
    }
  | { ok: false; code: "outcome_unknown" | "key_revoked"; id: string };

/** Transition outcome: moved, the row is not in `from`, or `rev` mismatch. */
export type TransitionResult = "ok" | "conflict" | "stale";

/**
 * Key-sorted JSON, so the same args always hash the same. Undefined keys
 * are skipped (Firestore drops them too), a Date is `{"$date": iso}`, and
 * any other non-plain object throws rather than hashing as `{}`.
 */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v instanceof Date) return canonical({ $date: v.toISOString() });
  if (v && typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error("canonical: only plain objects, arrays and Dates are supported");
    }
    const obj = v as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** A fresh per-generation nonce: a decision must name the generation it saw. */
const newRev = () => randomBytes(12).toString("hex");

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
 * Dedupe is pending-only: a `pending` or `executing` row returns its id (a
 * pending row's preview is refreshed, with a new `rev`, if it changed), an
 * `unsettled` row refuses (its action may already have happened), and a
 * terminal row moves to `history` so the id is re-used as a fresh `pending`
 * generation with a new `rev`. A revoked or missing key queues nothing.
 */
export async function createProposal(input: ProposalInput): Promise<CreateProposalResult> {
  const id = proposalId(input);
  const ref = proposalRef(id);
  const db = getAdminDb();
  const keyRef = db.doc(`subAccounts/${input.subAccountId}/apiKeys/${input.keyId}`);
  return db.runTransaction(async (tx) => {
    const [snap, keySnap] = await Promise.all([tx.get(ref), tx.get(keyRef)]);
    if (!keySnap.exists || keySnap.data()?.revokedAt) {
      return { ok: false, code: "key_revoked", id };
    }
    const cur = snap.data();
    const status = cur?.status as ProposalStatus | undefined;
    if (status === "executing") {
      return { ok: true, id, status, rev: cur!.rev, summary: cur!.summary, preview: cur!.preview };
    }
    // A pending row past its expiry is dead: roll it over like a terminal one.
    const expired = status === "pending" && (millis(cur!.expiresAt) ?? Infinity) < Date.now();
    if (status === "pending" && !expired) {
      if (canonical(cur!.preview) === canonical(input.preview)) {
        return { ok: true, id, status, rev: cur!.rev, summary: cur!.summary, preview: cur!.preview };
      }
      const rev = newRev();
      tx.update(ref, { preview: input.preview, rev });
      return { ok: true, id, status, rev, summary: cur!.summary, preview: input.preview };
    }
    if (status === "unsettled") return { ok: false, code: "outcome_unknown", id };
    if (expired) tx.set(historyRef(id), { ...cur!, status: "expired" });
    else if (status && TERMINAL.includes(status)) tx.set(historyRef(id), cur!);
    const now = Date.now();
    const rev = newRev();
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
      contactId: input.contactId,
      workflowId: input.workflowId ?? null,
      status: "pending",
      rev,
      createdAt: new Date(now),
      expiresAt: new Date(now + TTL_MS),
      claimedAt: null,
      claimId: null,
      decidedAt: null,
      decidedByUid: null,
      decidedByEmail: null,
      result: null,
      error: null,
    });
    return { ok: true, id, status: "pending", rev, summary: input.summary, preview: input.preview };
  });
}

/**
 * Move a row `from` → `patch.status` only when, at read time, its status is
 * still `from`, its generation is still `rev` (person decisions), and its
 * claim is still `claimId` (sweeps of a claim).
 */
export async function transitionIf(
  id: string,
  from: ProposalStatus,
  patch: Record<string, unknown> & { status?: ProposalStatus },
  guard: { rev?: string; claimId?: string } = {}
): Promise<TransitionResult> {
  const ref = proposalRef(id);
  return getAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.data();
    if (!cur || cur.status !== from) return "conflict";
    if (guard.rev !== undefined && cur.rev !== guard.rev) return "stale";
    if (guard.claimId !== undefined && cur.claimId !== guard.claimId) return "conflict";
    tx.update(ref, patch);
    return "ok";
  });
}

/** The approve claim: `pending` → `executing`, for generation `rev` only. */
export async function claimProposal(
  id: string,
  by: { uid: string; email: string },
  rev: string
): Promise<{ claimId: string } | "conflict" | "stale"> {
  const claimedAt = new Date();
  // A random token, not the timestamp: two claims in one millisecond (a
  // re-proposal claimed right after) must never look like the same claim.
  const claimId = newRev();
  const moved = await transitionIf(
    id,
    "pending",
    {
      status: "executing",
      claimedAt,
      claimId,
      decidedAt: claimedAt,
      decidedByUid: by.uid,
      decidedByEmail: by.email,
    },
    { rev }
  );
  return moved === "ok" ? { claimId } : moved;
}

/**
 * True when an earlier generation's claim settled `executed` in `history`
 * after the current generation was created: the action this row repeats has
 * already happened, so approving it would do it twice.
 */
export async function previousAttemptSent(id: string, createdAtMs: number): Promise<boolean> {
  const snap = await proposalRef(id)
    .collection("history")
    .where("lateSettle", "==", true)
    .where("status", "==", "executed")
    .get();
  // `>=`: a settle in the same millisecond as the re-proposal still counts.
  return snap.docs.some((d) => (millis(d.data().settledAt) ?? 0) >= createdAtMs);
}

/** Store a freshly computed preview under a new `rev` (pending generation
 *  `rev` only). Returns the new rev, or null when the row moved on. */
export async function refreshPreview(
  id: string,
  rev: string,
  preview: Array<{ label: string; value: string }>
): Promise<string | null> {
  const next = newRev();
  return (await transitionIf(id, "pending", { preview, rev: next }, { rev })) === "ok"
    ? next
    : null;
}

/**
 * Settle a claimed row and write its `aiSuiteActions` row in one
 * transaction. If the sweep flipped OUR claim to `unsettled`, the outcome is
 * now known, so the row resolves to it (`settledLate`) and `mark_*` no
 * longer apply. Any other moved row gets the outcome in `history`, logged.
 */
export async function settleProposal(
  id: string,
  claimId: string,
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
): Promise<"settled" | "resolved_late" | "late"> {
  const db = getAdminDb();
  const ref = proposalRef(id);
  const fields =
    outcome.status === "executed"
      ? { status: outcome.status, result: outcome.result }
      : { status: outcome.status, error: outcome.error };
  const verdict = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const cur = snap.data();
    const ours = cur?.claimId === claimId;
    // A person who marked OUR unsettled claim "not sent" guessed; the real
    // outcome beats the guess (else a re-propose could send it twice).
    const overridesHuman =
      ours && cur?.status === "rejected" && cur?.reason === "not_sent_confirmed";
    const v =
      ours && cur?.status === "executing"
        ? "settled"
        : (ours && cur?.status === "unsettled") || overridesHuman
          ? "resolved_late"
          : "late";
    if (v === "settled") tx.update(ref, fields);
    else if (v === "resolved_late") {
      tx.update(ref, { ...fields, settledLate: true, ...(overridesHuman ? { overrodeHuman: true } : {}) });
    } else {
      tx.set(historyRef(id), { lateSettle: true, claimId, settledAt: new Date(), ...fields });
    }
    tx.set(db.collection("aiSuiteActions").doc(), {
      level: "sub-account",
      ...audit,
      status: outcome.status,
      resultRef: outcome.status === "executed" ? outcome.result.ref : null,
      error: outcome.status === "failed" ? outcome.error : null,
      agentProposalId: id,
      createdAt: FieldValue.serverTimestamp(),
    });
    return v;
  });
  if (verdict === "late") {
    console.error(`[agent-proposals] late settle of ${id} (${outcome.status}) recorded in history`);
  }
  return verdict;
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
    if (moved === "ok") rejected++;
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
    if ((await transitionIf(doc.id, "pending", { status: "expired", decidedAt: now })) === "ok") {
      moved++;
    }
  }
  for (const doc of stale.docs) {
    const claimId = doc.data().claimId as string;
    if ((await transitionIf(doc.id, "executing", { status: "unsettled" }, { claimId })) === "ok") {
      moved++;
    }
  }
  return {
    collection: "agentProposals",
    deleted: moved,
    hitCap: expiring.size >= SWEEP_LIMIT || stale.size >= SWEEP_LIMIT,
  };
}
