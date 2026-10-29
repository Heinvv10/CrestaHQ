import "server-only";

import { isDocId } from "@/lib/server/doc-id";
import {
  aiSmsActivationBlock,
  listWorkflowRuns,
  listWorkflows,
  type WorkflowPatch,
} from "@/lib/server/workflows-service";
import { liveRunsQuery, updateWorkflowGuarded } from "@/lib/server/workflows-guarded";
import type { WorkflowDoc } from "@/types/workflows";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { agentActor, str } from "./helpers";
import { oneLine } from "./text-safety";
import { EDITABLE, patchOf, REENTRY } from "./workflow-args";
import { readableJson, tenantWorkflow, workflowFingerprint, workflowIdParam, workflowReviewRows } from "./workflow-support";

/**
 * Workflow reads and update_workflow for API agents (AGENT_API_V1_PLAN.md,
 * PR9). An edit to a draft or paused workflow is a direct write; an edit to
 * an ACTIVE one, or to the steps of one with runs in progress (a draft's
 * test run reads the steps live, and sends for real), changes what already
 * runs, so it is queued for approval (checked again at write time, in a
 * transaction). The status never changes here: that is set_workflow_status.
 */

/** Refusing a direct edit to an active workflow, per surface. */
const ACTIVE_AGENT = "The workflow is active now, so editing it needs approval: send the edit again.";
const ACTIVE_CHAT =
  "The workflow is active, so it can't be edited here. Pause it first (set_workflow_status paused), make the edit, then set it active again.";

/** Changes what a run executes next (runs read the steps live). */
const touchesSteps = (args: Record<string, unknown>) => args.nodes !== undefined || args.startNodeId !== undefined;

/** An edit leaving an ACTIVE workflow with a Send AI text step this workspace
 *  can't run is refused, as the builder's save is. */
async function aiSmsEditBlock(subAccountId: string, args: Record<string, unknown>, wf: WorkflowDoc): Promise<void> {
  if (wf.status !== "active") return;
  const nodes = (args.nodes ?? wf.nodes) as WorkflowDoc["nodes"];
  const block = await aiSmsActivationBlock(subAccountId, nodes);
  if (block) throw new CapabilityUserError(block);
}

/** The start step after the patch must be one of the steps after it. */
function startProblem(args: Record<string, unknown>, wf: WorkflowDoc): string | null {
  if (!touchesSteps(args)) return null;
  const nodes = (args.nodes ?? wf.nodes ?? {}) as Record<string, unknown>;
  const start = args.startNodeId !== undefined ? args.startNodeId : wf.startNodeId;
  if (typeof start !== "string" || Object.hasOwn(nodes, start)) return null;
  return args.startNodeId !== undefined
    ? "The start step must be one of the workflow's steps."
    : `The new steps don't include the current start step (${start}): send startNodeId too, a step id or null.`;
}

export const WORKFLOW_EDIT_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "list_workflows",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    readonly: true,
    surfaces: ["chat", "agent"],
    menuLabel: "List this workspace's workflows",
    description: "List the sub-account's automation workflows: name, id, status and trigger. Use it to find a workflow's id.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "List workflows.",
    execute: async (ctx) => {
      const all = await listWorkflows(ctx.subAccountId!);
      const shown = all.slice(0, 100);
      if (!shown.length) return { resultText: "No workflows." };
      const lines = shown.map(
        (w) => `- ${oneLine(w.name) || "(unnamed)"} — id: ${w.id}, status: ${w.status}, trigger: ${w.trigger?.type ?? "(none)"}`
      );
      return { resultText: `Workflows (${shown.length}):\n${lines.join("\n")}`, ...(all.length > shown.length ? { truncated: true as const } : {}) };
    },
  },
  {
    name: "get_workflow",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    readonly: true,
    surfaces: ["chat", "agent"],
    menuLabel: "Read one workflow in full",
    description: "Read one workflow: status, trigger, re-entry, start step and every step (as JSON). Read it before update_workflow: `nodes` replaces them all.",
    parameters: { type: "object", properties: { workflowId: workflowIdParam }, required: ["workflowId"], additionalProperties: false },
    validate: (raw) => {
      const workflowId = str(raw, "workflowId");
      if (!isDocId(workflowId)) return { ok: false, error: "a workflowId is required" };
      return { ok: true, args: { workflowId } };
    },
    summarize: () => "Read a workflow.",
    execute: async (ctx, args) => {
      const wf = await tenantWorkflow(ctx.subAccountId!, args.workflowId);
      const { name, status, trigger, reentry, startNodeId, nodes } = wf;
      return { resultText: readableJson({ id: wf.id, name, status, trigger, reentry: reentry ?? "every_time", startNodeId, nodes }) };
    },
  },
  {
    name: "list_workflow_runs",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    readonly: true,
    surfaces: ["agent"],
    menuLabel: "List a workflow's recent runs",
    description: "List a workflow's most recent runs (up to 100): the contact, status, whether it was a test, when it started, and its last step.",
    parameters: { type: "object", properties: { workflowId: workflowIdParam }, required: ["workflowId"], additionalProperties: false },
    validate: (raw) => {
      const workflowId = str(raw, "workflowId");
      if (!isDocId(workflowId)) return { ok: false, error: "a workflowId is required" };
      return { ok: true, args: { workflowId } };
    },
    summarize: () => "List a workflow's runs.",
    execute: async (ctx, args) => {
      const wf = await tenantWorkflow(ctx.subAccountId!, args.workflowId);
      const runs = await listWorkflowRuns(ctx.subAccountId!, wf.id);
      if (!runs.length) return { resultText: "No runs." };
      const lines = runs.map((r) => {
        const last = r.history.at(-1);
        return `- run ${r.id} — contact: ${oneLine(r.contactName)} (${r.contactId}), status: ${r.status}${r.test ? " (test)" : ""}, started: ${new Date(r.enrolledAtMs).toISOString()}, last step: ${last ? `${last.type} (${last.result})` : "none"}`;
      });
      return { resultText: `Runs (most recent ${runs.length}):\n${lines.join("\n")}` };
    },
  },
  {
    name: "update_workflow",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["chat", "agent"],
    menuLabel: "Edit a workflow (a person approves edits to an active one)",
    description:
      "Change a workflow's name, trigger, re-entry, steps (`nodes` replaces them all; read get_workflow first) or start step. A draft or paused workflow changes at once. An active one: through the Agent API the edit is queued for a sub-account admin to approve; in the in-app assistant it is refused, so pause it first (set_workflow_status paused), edit it, then set it active again. It never changes the status (use set_workflow_status).",
    parameters: {
      type: "object",
      properties: {
        workflowId: workflowIdParam,
        name: { type: "string" },
        trigger: { type: "object", description: "{ type, filters, … } as get_workflow shows it." },
        reentry: { type: "string", enum: [...REENTRY] },
        nodes: { type: "object", description: "Every step, keyed by step id, as get_workflow shows them." },
        startNodeId: { type: ["string", "null"] },
      },
      required: ["workflowId"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const workflowId = str(raw, "workflowId");
      if (!isDocId(workflowId)) return { ok: false, error: "a workflowId is required" };
      const p = patchOf(raw);
      return p.ok ? { ok: true, args: { workflowId, ...p.patch } } : p;
    },
    summarize: (args) => `Edit the workflow ${args.workflowId} (${EDITABLE.filter((k) => args[k] !== undefined).join(", ")}).`,
    // Editing what runs — an active workflow, or the steps of one with runs
    // in progress (a draft's test run reads them live) — needs a person.
    approvalFor: async (args, ctx) => {
      const wf = await tenantWorkflow(ctx.subAccountId!, args.workflowId);
      if (wf.status === "active") return "workflow_activate";
      return touchesSteps(args) && !(await liveRunsQuery(wf.id).get()).empty ? "workflow_activate" : undefined;
    },
    approvalHint: { approval: "workflow_activate", when: "the workflow is active, or the edit changes its steps while runs are in progress" },
    // The preview is the whole workflow: splitting the edit wouldn't shrink it.
    proposalTooLargeMessage: "This workflow is too large to review as one approval; edit it in the builder.",
    // Workflows carry no territory: the approval is tenant-wide.
    approvalTarget: async (ctx, args) => {
      await tenantWorkflow(ctx.subAccountId!, args.workflowId);
      return { contactId: null, territoryId: null, scoped: false };
    },
    preview: async (ctx, args) => {
      const wf = await tenantWorkflow(ctx.subAccountId!, args.workflowId);
      const bad = startProblem(args, wf);
      if (bad) throw new CapabilityUserError(bad);
      await aiSmsEditBlock(ctx.subAccountId!, args, wf);
      // The whole workflow as it will be, not just the changed fields: a new
      // start step or a wider trigger runs steps the patch never mentions.
      const { workflowId: _id, ...patch } = args;
      return {
        rows: [
          { label: "Changes", value: EDITABLE.filter((k) => args[k] !== undefined).join(", ") },
          ...workflowReviewRows({ ...wf, ...patch }),
          { label: "Then", value: "Every enrolment from then on runs the new version, and runs already in progress switch to the new steps at their next step." },
        ],
        pinned: { workflowId: wf.id, fingerprint: workflowFingerprint(wf) },
      };
    },
    execute: async (ctx, args) => {
      const { workflowId, ...patch } = args as unknown as { workflowId: string } & WorkflowPatch;
      await aiSmsEditBlock(ctx.subAccountId!, args, await tenantWorkflow(ctx.subAccountId!, workflowId));
      const done = await updateWorkflowGuarded({
        subAccountId: ctx.subAccountId!,
        workflowId,
        patch,
        actor: agentActor(ctx, "update_workflow"),
        // Only a direct steps edit depends on runs in progress.
        checkRuns: !ctx.approved && touchesSteps(args),
        guard: (current, liveRun) => {
          if (ctx.approved) {
            if (workflowFingerprint(current) !== ctx.approved.pinned?.fingerprint) {
              throw new CapabilityUserError("The workflow changed since this was reviewed; nothing was changed.");
            }
          } else if (current.status === "active") {
            // Only the agent surface has an approval queue; chat has none.
            throw new CapabilityUserError(ctx.apiKey ? ACTIVE_AGENT : ACTIVE_CHAT);
          } else if (touchesSteps(args) && liveRun) {
            throw new CapabilityUserError("The workflow has runs in progress, so changing its steps needs approval: send the edit again.");
          }
          const bad = startProblem(args, current);
          if (bad) throw new CapabilityUserError(bad);
        },
      });
      if (!done) throw new CapabilityUserError("That workflow isn't in this workspace.");
      return { resultText: "Updated the workflow.", ref: { kind: "workflow", id: workflowId } };
    },
  },
];
