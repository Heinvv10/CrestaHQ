import "server-only";

import { createHash } from "node:crypto";
import { isDocId } from "@/lib/server/doc-id";
import { getWorkflow } from "@/lib/server/workflows-service";
import { canonical } from "@/lib/server/agent-proposals-encoding";
import { TRIGGER_LABELS } from "@/lib/workflows/catalog";
import type { WorkflowDoc } from "@/types/workflows";
import { CapabilityUserError, type PreviewRow } from "./types";
import { oneLine } from "./text-safety";

/** What the agent workflow capabilities share: the tenant lookup, a
 *  fingerprint of what a workflow does, and verbatim preview rows. */

export const workflowIdParam = { type: "string", description: "The workflow's id (from list_workflows)." };

/** The workflow, re-anchored to the sub-account; refused otherwise. */
export async function tenantWorkflow(subAccountId: string, workflowId: unknown): Promise<WorkflowDoc> {
  const wf = isDocId(workflowId) ? await getWorkflow(subAccountId, workflowId) : null;
  if (!wf) throw new CapabilityUserError("That workflow isn't in this workspace.");
  return wf;
}

/** A hash of everything that decides what a workflow does, so what runs is
 *  what the approver reviewed. */
export function workflowFingerprint(wf: WorkflowDoc): string {
  return createHash("sha256")
    .update(canonical([wf.name, wf.status, wf.trigger ?? null, wf.reentry ?? "every_time", wf.startNodeId ?? null, wf.nodes ?? {}]))
    .digest("hex");
}

/** A hash of a workflow's steps alone (the start step and the nodes), for
 *  approvals that start a workflow without changing it: a steps edit after
 *  the review changes it, a pause or a rename doesn't. */
export function workflowStepsFingerprint(wf: Pick<WorkflowDoc, "startNodeId" | "nodes">): string {
  return createHash("sha256").update(canonical([wf.startNodeId ?? null, wf.nodes ?? {}])).digest("hex");
}

/** Keys sorted, so a value reads the same however it was stored. */
function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted);
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]));
  }
  return v;
}

/**
 * JSON an approver can read exactly: keys sorted, indented, and everything
 * outside printable ASCII escaped (so nothing invisible hides in a step's
 * text, and the row is a safe multiline preview value).
 */
export function readableJson(v: unknown): string {
  return JSON.stringify(sorted(v) ?? null, null, 2).replace(
    /[^\n\x20-\x7e]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

/** Rows naming the workflow and what it does now. */
export function workflowRows(wf: WorkflowDoc): PreviewRow[] {
  return [
    { label: "Workflow", value: `${oneLine(wf.name) || "(unnamed)"} (${wf.id})` },
    { label: "Status", value: wf.status },
    { label: "Trigger", value: TRIGGER_LABELS[wf.trigger?.type] ?? String(wf.trigger?.type ?? "(none)") },
    { label: "Steps", value: String(Object.keys(wf.nodes ?? {}).length) },
    // Quoted and escaped: a look-alike id can't pass for another step's.
    { label: "Start step", value: wf.startNodeId == null ? "(none)" : readableJson(wf.startNodeId) },
  ];
}

/** Everything an approver needs to judge what a workflow will do: the rows
 *  above, plus its re-entry and its exact trigger and steps. */
export function workflowReviewRows(wf: WorkflowDoc): PreviewRow[] {
  return [
    ...workflowRows(wf),
    { label: "Re-entry", value: wf.reentry ?? "every_time" },
    { label: "Trigger (exact)", value: readableJson(wf.trigger), multiline: true },
    { label: "Steps (exact)", value: readableJson(wf.nodes), multiline: true },
  ];
}
