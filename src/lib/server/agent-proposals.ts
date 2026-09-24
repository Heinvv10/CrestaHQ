import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { getAdminDb } from "@/lib/firebase/admin";
import type { CapabilityApproval } from "@/lib/ai-suite/capabilities";
import {
  canonical,
  millis,
  type PreviewRows,
} from "@/lib/server/agent-proposals-encoding";

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
/** The approve path gives up waiting on execute after this (< STALE_CLAIM_MS)
 *  and marks the row `unsettled` itself. */
export const EXECUTE_DEADLINE_MS = 5 * 60 * 1000;
/** mark_sent / mark_not_sent are refused until this long after the claim. */
export const MARK_MIN_AGE_MS = 60 * 60 * 1000;

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
  preview: PreviewRows;
  /** Values the reviewed action is pinned to (see AiSuiteCapability.preview). */
  pinned: Record<string, unknown> | null;
  /** workflow_enrolment rows only: one row per matched workflow. */
  workflowId?: string;
  /** What the action targets (AiSuiteCapability.approvalTarget). */
  target: { contactId: string | null; territoryId: string | null; scoped: boolean };
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

/** A fresh per-generation nonce: a decision must name the generation it saw. */
const newRev = () => randomBytes(12).toString("hex");

/** The action's identity, NOT the key's: the same action proposed by two
 *  keys is one row, so unsettled / executing / priorAttemptSent hold across
 *  keys. The row's keyId is the key that created its current generation. */
export function proposalId(input: ProposalInput): string {
  const key = [
    input.subAccountId,
    input.capability,
    canonical(input.args),
    input.workflowId ?? "",
  ].join("|");
  return `p_${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
}

const proposalRef = (id: string) => getAdminDb().doc(`agentProposals/${id}`);
const historyRef = (id: string) => proposalRef(id).collection("history").doc();

/**
 * Dedupe is pending-only: a `pending` or `executing` row returns its id
 * unchanged (only the approve recheck refreshes a preview, so an agent
 * re-proposing cannot keep bumping `rev` under an approver), an `unsettled`
 * row refuses (its action may already have happened), and a terminal row
 * moves to `history` so the id is re-used as a fresh `pending` generation
 * with a new `rev`, stamped with the proposing key. A revoked or missing key
 * queues nothing. The row stores its target (`contactId`, `territoryId`,
 * `targetScoped`) so firestore.rules and the routes can scope reads.
 */
export async function createProposal(input: ProposalInput): Promise<CreateProposalResult> {
  const id = proposalId(input);
  const ref = proposalRef(id);
  const db = getAdminDb();
  const keyRef = db.doc(`subAccounts/${input.subAccountId}/apiKeys/${input.keyId}`);
  return db.runTransaction(async (tx) => {
    // A contact target's territory is read HERE, inside the transaction: a
    // re-tag committing meanwhile makes this transaction retry and store the
    // current territory (the re-tag's own cascade may already have run).
    const contactRef = input.target.contactId
      ? db.doc(`contacts/${input.target.contactId}`)
      : null;
    const [snap, keySnap, contactSnap] = await Promise.all([
      tx.get(ref),
      tx.get(keyRef),
      contactRef ? tx.get(contactRef) : null,
    ]);
    if (!keySnap.exists || keySnap.data()?.revokedAt) {
      return { ok: false, code: "key_revoked", id };
    }
    const cur = snap.data();
    const status = cur?.status as ProposalStatus | undefined;

    // A pending row past its expiry is dead: roll it over like a terminal one.
    const expired = status === "pending" && (millis(cur!.expiresAt) ?? Infinity) < Date.now();
    if (status === "executing" || (status === "pending" && !expired)) {
      return { ok: true, id, status, rev: cur!.rev, summary: cur!.summary, preview: cur!.preview };
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
      pinned: input.pinned,
      contactId: input.target.contactId,
      territoryId: contactSnap
        ? ((contactSnap.data()?.territoryId as string | undefined) ?? null)
        : input.target.territoryId,
      targetScoped: input.target.scoped,
      // Sticky: once an attempt is known to have sent, it never clears.
      priorAttemptSent: cur?.priorAttemptSent ?? null,
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

/** Store a freshly computed preview under a new `rev` (pending generation
 *  `rev` only). Returns the new rev, or null when the row moved on. */
export async function refreshPreview(
  id: string,
  rev: string,
  preview: { rows: PreviewRows; pinned: Record<string, unknown> | null }
): Promise<string | null> {
  const next = newRev();
  const patch = { preview: preview.rows, pinned: preview.pinned, rev: next };
  return (await transitionIf(id, "pending", patch, { rev })) === "ok"
    ? next
    : null;
}
