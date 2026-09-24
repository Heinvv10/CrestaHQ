import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { CapabilityUserError, type ExecuteResult } from "@/lib/ai-suite/capabilities";
import { EXECUTE_DEADLINE_MS, transitionIf } from "@/lib/server/agent-proposals";

/**
 * Running an approved proposal and settling its outcome: the one place the
 * approve path's execute happens, under a deadline, and the late-settle
 * rules for whatever the row became meanwhile.
 */

const proposalRef = (id: string) => getAdminDb().doc(`agentProposals/${id}`);
const historyRef = (id: string) => proposalRef(id).collection("history").doc();

export type SettleOutcome =
  | { status: "executed"; result: { resultText: string; ref: { kind: string; id: string } | null } }
  | { status: "failed"; error: string };

export interface SettleAudit {
  agencyId: string;
  subAccountId: string;
  capability: string;
  args: Record<string, unknown>;
  summary: string;
  confirmedByUid: string;
  confirmedByEmail: string;
}

/**
 * Settle a claimed row and write its `aiSuiteActions` row in one
 * transaction. If OUR claim was flipped to `unsettled`, or a person marked
 * it (`mark_sent` / `mark_not_sent` are guesses), the outcome is now known,
 * so the row resolves to it (`settledLate`, plus `overrodeHuman`). Otherwise the outcome goes to `history`, logged — and an
 * `executed` outcome rejects a newer `pending` generation in the same
 * transaction, since approving it would do the action twice.
 */
export async function settleProposal(
  id: string,
  claimId: string,
  outcome: SettleOutcome,
  audit: SettleAudit
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
    // Any late settle on OUR claim overrides a person's mark_*: they guessed,
    // this is the real outcome.
    const overridesHuman =
      ours &&
      ((cur?.status === "rejected" && cur?.reason === "not_sent_confirmed") ||
        (cur?.status === "executed" && cur?.settledBy === "human"));
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
      const settledAt = new Date();
      tx.set(historyRef(id), { lateSettle: true, claimId, settledAt, ...fields });
      // The action went out after all: every later generation must know.
      if (cur && outcome.status === "executed") {
        tx.update(ref, {
          priorAttemptSent: { claimId, settledAt },
          ...(cur.status === "pending"
            ? { status: "rejected", reason: "previous_attempt_sent", decidedAt: settledAt }
            : {}),
        });
      }
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

/**
 * Run `execute` for a claimed row and settle it, under a hard deadline well
 * inside the sweep's stale-claim window. Past the deadline this marks the row
 * `unsettled` itself, aborts the signal and returns "deadline"; the real
 * outcome, whenever it lands, arrives through the late-settle path.
 */
export async function executeAndSettle(input: {
  id: string;
  claimId: string;
  execute: (signal: AbortSignal) => Promise<ExecuteResult>;
  audit: SettleAudit;
}): Promise<SettleOutcome | "deadline"> {
  const abort = new AbortController();
  const run = (async () => {
    let outcome: SettleOutcome;
    try {
      const result = await input.execute(abort.signal);
      outcome = {
        status: "executed",
        result: { resultText: result.resultText, ref: result.ref ?? null },
      };
    } catch (err) {
      if (!(err instanceof CapabilityUserError)) {
        console.error(`[agent-proposals] approve ${input.id} failed:`, err);
      }
      outcome = {
        status: "failed",
        error: err instanceof CapabilityUserError ? err.message : "The action failed to run.",
      };
    }
    await settleProposal(input.id, input.claimId, outcome, input.audit);
    return outcome;
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), EXECUTE_DEADLINE_MS);
  });
  const outcome = await Promise.race([run, deadline]);
  clearTimeout(timer);
  if (outcome === "deadline") {
    // `run` still settles in the background; its failure must be seen.
    run.catch((err) => console.error("[agent-proposals] post-deadline settle failed", err));
    abort.abort();
    await transitionIf(input.id, "executing", { status: "unsettled" }, { claimId: input.claimId });
  }
  return outcome;
}
