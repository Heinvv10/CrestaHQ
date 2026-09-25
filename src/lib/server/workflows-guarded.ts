import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { agentEditStamp } from "@/lib/server/agent-edit-stamp";
import type { AgentActor } from "@/lib/workflows/agent-hold";
import type { WorkflowDoc, WorkflowStatus } from "@/types/workflows";
import { workflowPatchWrite, type WorkflowPatch } from "./workflows-service";

/** Runs of a workflow still going (a test run of a draft included): they
 *  read the steps live, at each step. */
export function liveRunsQuery(workflowId: string) {
  return getAdminDb()
    .collection("workflowRuns")
    .where("workflowId", "==", workflowId)
    .where("status", "in", ["running", "waiting"])
    .limit(1);
}

/**
 * updateWorkflowServerSide in a transaction, for a caller whose right to
 * write depends on the workflow as it is at write time (an API agent edits
 * a draft directly, an active workflow only through an approval): `guard`
 * sees the live doc and throws to refuse. Null when the workflow is not
 * this sub-account's; else its status before the patch.
 */
export async function updateWorkflowGuarded(opts: {
  subAccountId: string;
  workflowId: string;
  patch: WorkflowPatch;
  /** `liveRun`: a run of it is in progress (read in the transaction). */
  guard: (current: WorkflowDoc, liveRun: boolean) => void;
  /** An API agent's write: stamped (see agentEditStamp). */
  actor?: AgentActor;
}): Promise<{ previousStatus: WorkflowStatus } | null> {
  const db = getAdminDb();
  const ref = db.doc(`workflows/${opts.workflowId}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.data()!.subAccountId !== opts.subAccountId) return null;
    const current = { id: snap.id, ...(snap.data() as Omit<WorkflowDoc, "id">) };
    const runs = await tx.get(liveRunsQuery(opts.workflowId));
    opts.guard(current, !runs.empty);
    tx.update(ref, { ...workflowPatchWrite(opts.patch), ...agentEditStamp(opts.actor) });
    return { previousStatus: current.status };
  });
}
