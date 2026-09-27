import { createHash } from "node:crypto";
import { canonical } from "@/lib/server/agent-proposals-encoding";
import type { WorkflowDoc } from "@/types/workflows";

/** A hash of a workflow's steps alone (the start step and the nodes), for
 *  approvals that start a workflow without changing it: a steps edit after
 *  the review changes it, a pause or a rename doesn't. */
export function workflowStepsFingerprint(wf: Pick<WorkflowDoc, "startNodeId" | "nodes">): string {
  return createHash("sha256").update(canonical([wf.startNodeId ?? null, wf.nodes ?? {}])).digest("hex");
}
