import "server-only";

import { isDocId } from "@/lib/server/doc-id";
import { getAdminDb } from "@/lib/firebase/admin";
import { recordSubAccountAuditEvent } from "@/lib/audit/record";
import { deleteWorkflowServerSide } from "@/lib/server/workflows-service";
import { updateWorkflowGuarded } from "@/lib/server/workflows-guarded";
import type { WorkflowStatus } from "@/types/workflows";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { str } from "./helpers";
import { oneLine } from "./text-safety";
import { recordProvenanceRows } from "./record-provenance";
import { tenantWorkflow, workflowFingerprint, workflowIdParam, workflowReviewRows, workflowRows } from "./workflow-support";

/**
 * set_workflow_status and delete_workflow for API agents (PR9). Pausing or
 * returning a workflow to draft only stops it, so it is a direct write;
 * activating one starts sending to real contacts, so a person approves the
 * exact trigger and steps (pinned: they must not change before it runs).
 * Deleting one is always approved.
 */

const STATUSES: readonly WorkflowStatus[] = ["draft", "paused", "active"];

/** Workflows carry no territory: their approvals are tenant-wide. */
const workflowTarget: NonNullable<AiSuiteCapability["approvalTarget"]> = async (ctx, args) => {
  await tenantWorkflow(ctx.subAccountId!, args.workflowId);
  return { contactId: null, territoryId: null, scoped: false };
};

export const WORKFLOW_STATUS_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "set_workflow_status",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["chat", "agent"],
    menuLabel: "Pause, draft or activate a workflow (a person approves activating)",
    description:
      "Set a workflow's status: `paused` or `draft` stop it at once; `active` is queued for a sub-account admin to approve, showing the exact trigger and steps that will run.",
    parameters: {
      type: "object",
      properties: { workflowId: workflowIdParam, status: { type: "string", enum: [...STATUSES] } },
      required: ["workflowId", "status"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const workflowId = str(raw, "workflowId");
      if (!isDocId(workflowId)) return { ok: false, error: "a workflowId is required" };
      const status = str(raw, "status") as WorkflowStatus;
      if (!STATUSES.includes(status)) return { ok: false, error: `status must be one of ${STATUSES.join(", ")}` };
      return { ok: true, args: { workflowId, status } };
    },
    summarize: (args) => `Set the workflow ${args.workflowId} to ${args.status}.`,
    approvalFor: (args) => (args.status === "active" ? "workflow_activate" : undefined),
    approvalHint: { approval: "workflow_activate", when: "status=active" },
    approvalTarget: workflowTarget,
    preview: async (ctx, args) => {
      const wf = await tenantWorkflow(ctx.subAccountId!, args.workflowId);
      if (wf.status === "active") throw new CapabilityUserError("That workflow is already active.");
      return {
        rows: [
          ...workflowReviewRows(wf),
          { label: "Then", value: "From approval on, every contact matching the trigger is enrolled and these steps run, messages included; runs still waiting from before (e.g. a pause) resume on these steps." },
        ],
        pinned: { workflowId: wf.id, fingerprint: workflowFingerprint(wf) },
      };
    },
    execute: async (ctx, args) => {
      const status = args.status as WorkflowStatus;
      const done = await updateWorkflowGuarded({
        subAccountId: ctx.subAccountId!,
        workflowId: args.workflowId as string,
        patch: { status },
        guard: (current) => {
          // Activating runs what was reviewed, or nothing.
          if (ctx.approved && workflowFingerprint(current) !== ctx.approved.pinned?.fingerprint) {
            throw new CapabilityUserError("The workflow changed since this was reviewed; it was not activated.");
          }
        },
      });
      if (!done) throw new CapabilityUserError("That workflow isn't in this workspace.");
      if (done.previousStatus !== status) {
        // As the builder's own status change records it.
        await recordSubAccountAuditEvent(getAdminDb(), ctx.subAccountId!, {
          action: "workflow.status_changed",
          actor: ctx.apiKey ? { type: "api_key", id: ctx.apiKey.keyId } : { type: "user", id: ctx.uid },
          target: { type: "workflow", id: args.workflowId as string },
          changes: [
            { field: "status", before: done.previousStatus, after: status },
            // An agency key is not in this sub-account's key list: say where it lives.
            ...(ctx.apiKey ? [{ field: "keyLevel", before: null, after: ctx.apiKey.keyLevel }] : []),
          ],
        });
      }
      return { resultText: `The workflow is now ${status}.`, ref: { kind: "workflow", id: args.workflowId as string } };
    },
  },
  {
    name: "delete_workflow",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["agent"],
    approval: "hard_delete",
    menuLabel: "Delete a workflow (a person approves)",
    description: "Delete a workflow permanently. Queued for a sub-account admin to approve.",
    parameters: { type: "object", properties: { workflowId: workflowIdParam }, required: ["workflowId"], additionalProperties: false },
    validate: (raw) => {
      const workflowId = str(raw, "workflowId");
      if (!isDocId(workflowId)) return { ok: false, error: "a workflowId is required" };
      return { ok: true, args: { workflowId } };
    },
    summarize: () => "Delete a workflow.",
    approvalTarget: workflowTarget,
    preview: async (ctx, args) => {
      const wf = await tenantWorkflow(ctx.subAccountId!, args.workflowId);
      return [
        { label: "Delete workflow", value: oneLine(wf.name) || "(unnamed)" },
        ...recordProvenanceRows(wf.id, wf),
        ...workflowRows(wf).slice(1),
      ];
    },
    execute: async (ctx, args) => {
      if (!(await deleteWorkflowServerSide(ctx.subAccountId!, args.workflowId as string))) {
        throw new CapabilityUserError("That workflow isn't in this workspace.");
      }
      return { resultText: "Deleted the workflow.", ref: { kind: "workflow", id: args.workflowId as string } };
    },
  },
];
