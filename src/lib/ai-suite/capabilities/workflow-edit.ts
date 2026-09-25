import "server-only";

import { isDocId } from "@/lib/server/doc-id";
import { listWorkflows, type WorkflowPatch } from "@/lib/server/workflows-service";
import { updateWorkflowGuarded } from "@/lib/server/workflows-guarded";
import { TRIGGER_LABELS } from "@/lib/workflows/catalog";
import { sanitizeNodes } from "@/lib/workflows/sanitize-nodes";
import type { WorkflowReentry } from "@/types/workflows";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { agentActor, str } from "./helpers";
import { hasUnsafeText, oneLine, UNSAFE_TEXT_MESSAGE } from "./text-safety";
import { readableJson, tenantWorkflow, workflowFingerprint, workflowIdParam, workflowRows } from "./workflow-support";

/**
 * Workflow reads and update_workflow for API agents (AGENT_API_V1_PLAN.md,
 * PR9). An edit to a draft or paused workflow is a direct write; an edit to
 * an ACTIVE one changes what an automation already running does, so it is
 * queued for approval (checked again at write time, in a transaction). The
 * status never changes here: that is set_workflow_status.
 */

const REENTRY: readonly WorkflowReentry[] = ["every_time", "unless_active", "once_ever"];
const MAX_NODES = 100;
const MAX_JSON = 50_000;
const EDITABLE = ["name", "trigger", "reentry", "nodes", "startNodeId"] as const;

const plain = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;

/** The patch an agent's args ask for; `status` is never read. */
function patchOf(raw: unknown): { ok: true; patch: WorkflowPatch } | { ok: false; error: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const patch: WorkflowPatch = {};
  if (r.name !== undefined) {
    const name = typeof r.name === "string" ? r.name.trim() : "";
    if (!name || name.length > 120 || hasUnsafeText(name)) {
      return { ok: false, error: `name must be 1-120 characters of text, none that ${UNSAFE_TEXT_MESSAGE}` };
    }
    patch.name = name;
  }
  if (r.reentry !== undefined) {
    if (!REENTRY.includes(r.reentry as WorkflowReentry)) return { ok: false, error: `reentry must be one of ${REENTRY.join(", ")}` };
    patch.reentry = r.reentry as WorkflowReentry;
  }
  if (r.trigger !== undefined) {
    const t = r.trigger;
    if (!plain(t) || typeof t.type !== "string" || !Object.hasOwn(TRIGGER_LABELS, t.type)) {
      return { ok: false, error: `trigger must be an object whose type is one of ${Object.keys(TRIGGER_LABELS).join(", ")}` };
    }
    if (t.filters !== undefined && !plain(t.filters)) return { ok: false, error: "trigger.filters must be an object" };
    const trigger = JSON.parse(JSON.stringify({ ...t, filters: t.filters ?? { all: [] } }));
    if (JSON.stringify(trigger).length > MAX_JSON) return { ok: false, error: "the trigger is too large" };
    patch.trigger = trigger;
  }
  if (r.nodes !== undefined) {
    const nodes = plain(r.nodes) ? sanitizeNodes(r.nodes) : null;
    if (!nodes) return { ok: false, error: "nodes must be a map of step id → { type, config, next, branches } with known step types" };
    if (Object.keys(nodes).length > MAX_NODES) return { ok: false, error: `a workflow can have at most ${MAX_NODES} steps` };
    const json = JSON.stringify(nodes);
    if (json.length > MAX_JSON) return { ok: false, error: "the steps are too large" };
    patch.nodes = JSON.parse(json);
  }
  if (r.startNodeId !== undefined) {
    if (r.startNodeId !== null && typeof r.startNodeId !== "string") return { ok: false, error: "startNodeId must be a step id or null" };
    if (typeof r.startNodeId === "string" && patch.nodes && !Object.hasOwn(patch.nodes, r.startNodeId)) {
      return { ok: false, error: "startNodeId must be one of the steps" };
    }
    patch.startNodeId = r.startNodeId as string | null;
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: `give at least one of ${EDITABLE.join(", ")}` };
  return { ok: true, patch };
}

export const WORKFLOW_EDIT_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "list_workflows",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    readonly: true,
    surfaces: ["agent"],
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
    surfaces: ["agent"],
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
    name: "update_workflow",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["agent"],
    menuLabel: "Edit a workflow (a person approves edits to an active one)",
    description:
      "Change a workflow's name, trigger, re-entry, steps (`nodes` replaces them all; read get_workflow first) or start step. A draft or paused workflow changes at once; an active one is queued for a sub-account admin to approve. It never changes the status (use set_workflow_status).",
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
    // Its status decides: editing what an active automation does needs a person.
    approvalFor: async (args, ctx) =>
      (await tenantWorkflow(ctx.subAccountId!, args.workflowId)).status === "active" ? "workflow_activate" : undefined,
    approvalHint: { approval: "workflow_activate", when: "the workflow is active" },
    // Workflows carry no territory: the approval is tenant-wide.
    approvalTarget: async (ctx, args) => {
      await tenantWorkflow(ctx.subAccountId!, args.workflowId);
      return { contactId: null, territoryId: null, scoped: false };
    },
    preview: async (ctx, args) => {
      const wf = await tenantWorkflow(ctx.subAccountId!, args.workflowId);
      const changes = [
        ...(args.name !== undefined ? [{ label: "New name", value: String(args.name) }] : []),
        ...(args.reentry !== undefined ? [{ label: "New re-entry", value: String(args.reentry) }] : []),
        ...(args.startNodeId !== undefined ? [{ label: "New start step", value: String(args.startNodeId ?? "(none)") }] : []),
        ...(args.trigger !== undefined ? [{ label: "New trigger", value: readableJson(args.trigger), multiline: true as const }] : []),
        ...(args.nodes !== undefined ? [{ label: "New steps (replace all)", value: readableJson(args.nodes), multiline: true as const }] : []),
      ];
      return {
        rows: [...workflowRows(wf), ...changes, { label: "Then", value: "The active workflow runs the new version for every enrolment from then on." }],
        pinned: { workflowId: wf.id, fingerprint: workflowFingerprint(wf) },
      };
    },
    execute: async (ctx, args) => {
      const { workflowId, ...patch } = args as unknown as { workflowId: string } & WorkflowPatch;
      const done = await updateWorkflowGuarded({
        subAccountId: ctx.subAccountId!,
        workflowId,
        patch,
        actor: agentActor(ctx, "update_workflow"),
        guard: (current) => {
          if (ctx.approved) {
            if (workflowFingerprint(current) !== ctx.approved.pinned?.fingerprint) {
              throw new CapabilityUserError("The workflow changed since this was reviewed; nothing was changed.");
            }
          } else if (current.status === "active") {
            throw new CapabilityUserError("The workflow is active now, so editing it needs approval: send the edit again.");
          }
        },
      });
      if (!done) throw new CapabilityUserError("That workflow isn't in this workspace.");
      return { resultText: "Updated the workflow.", ref: { kind: "workflow", id: workflowId } };
    },
  },
];
