import "server-only";

import { isDocId } from "@/lib/server/doc-id";
import { countDeals, listPipelines, loadPipeline } from "@/lib/pipelines/server";
import { validatePipelineName, validateStages } from "@/lib/pipelines/stages";
import { createPipeline, deletePipeline, updatePipeline } from "@/lib/pipelines/write";
import type { PipelineDoc, PipelineStage } from "@/types/deals";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { agentActor, str } from "./helpers";
import { hasUnsafeText, oneLine, UNSAFE_TEXT_MESSAGE } from "./text-safety";
import { recordProvenanceRows } from "./record-provenance";
import { readableJson } from "./workflow-support";

/**
 * Pipeline capabilities for API agents (AGENT_API_V1_PLAN.md, PR9b): reads,
 * create / update as direct writes (through the settings routes' own
 * writers, so a stage with deals can't be dropped), delete approved. Names
 * and stage labels must be visible text: a label with something invisible
 * could pass for another stage.
 */

const pipelineIdParam = { type: "string", description: "The pipeline's id (from list_pipelines; the default is \"default\")." };
const stagesParam = {
  type: "array",
  description: "The FULL stage list, in order: [{ id?, label, terminal? }]. Keep each existing stage's id; a stage left out is deleted (refused while deals sit in it). terminal: \"won\" / \"lost\", one each at most.",
  items: { type: "object" },
};

/** Under this sub-account's own path, so another's id is simply not found
 *  (validate has already refused an id that isn't a doc id). */
async function tenantPipeline(subAccountId: string, pipelineId: unknown): Promise<PipelineDoc> {
  const p = await loadPipeline(subAccountId, pipelineId as string);
  if (!p) throw new CapabilityUserError("That pipeline isn't in this workspace.");
  return p;
}

/** name / stages as the settings UI would save them, plus visible text only. */
function pipelineFields(raw: unknown, required: boolean): { ok: true; name?: string; stages?: PipelineStage[] } | { ok: false; error: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const out: { ok: true; name?: string; stages?: PipelineStage[] } = { ok: true };
  if (r.name !== undefined || required) {
    const name = validatePipelineName(r.name);
    if (!name.ok) return name;
    if (hasUnsafeText(name.value)) return { ok: false, error: `the name ${UNSAFE_TEXT_MESSAGE}` };
    out.name = name.value;
  }
  if (r.stages !== undefined || required) {
    const stages = validateStages(r.stages);
    if (!stages.ok) return stages;
    const bad = stages.value.find((s) => hasUnsafeText(s.label));
    if (bad) return { ok: false, error: `the stage label for "${bad.id}" ${UNSAFE_TEXT_MESSAGE}` };
    out.stages = stages.value;
  }
  return out;
}

const describeStages = (stages: PipelineStage[]) =>
  stages.map((s) => `${oneLine(s.label)} (${s.id}${s.terminal ? `, ${s.terminal}` : ""})`).join(", ");

export const PIPELINE_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "list_pipelines",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    surfaces: ["agent"],
    menuLabel: "List this workspace's deal pipelines",
    description: "List the sub-account's pipelines with their stages (label, id, won/lost). Use a stage id with move_deal_stage.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    validate: () => ({ ok: true, args: {} }),
    summarize: () => "List pipelines.",
    execute: async (ctx) => {
      const all = await listPipelines(ctx.subAccountId!);
      const lines = all.map(
        (p) => `- ${oneLine(p.name) || "(unnamed)"} — id: ${p.id}${p.isDefault ? " (default)" : ""}; stages: ${describeStages(p.stages)}`
      );
      return { resultText: `Pipelines (${all.length}):\n${lines.join("\n")}` };
    },
  },
  {
    name: "get_pipeline",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    surfaces: ["agent"],
    menuLabel: "Read one pipeline",
    description: "Read one pipeline: its name and full stage list (as JSON). Read it before update_pipeline: `stages` replaces them all.",
    parameters: { type: "object", properties: { pipelineId: pipelineIdParam }, required: ["pipelineId"], additionalProperties: false },
    validate: (raw) => {
      const pipelineId = str(raw, "pipelineId");
      return isDocId(pipelineId) ? { ok: true, args: { pipelineId } } : { ok: false, error: "a pipelineId is required" };
    },
    summarize: () => "Read a pipeline.",
    execute: async (ctx, args) => {
      const p = await tenantPipeline(ctx.subAccountId!, args.pipelineId);
      return { resultText: readableJson({ id: p.id, name: p.name, isDefault: p.isDefault, stages: p.stages.map(({ id, label, terminal }) => ({ id, label, terminal })) }) };
    },
  },
  {
    name: "create_pipeline",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["agent"],
    menuLabel: "Create a deal pipeline",
    description: "Create a pipeline with its stages.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" }, stages: stagesParam },
      required: ["name", "stages"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const f = pipelineFields(raw, true);
      return f.ok ? { ok: true, args: { name: f.name, stages: f.stages } } : f;
    },
    summarize: (args) => `Create the pipeline “${args.name}”.`,
    execute: async (ctx, args) => {
      const id = await createPipeline({
        subAccountId: ctx.subAccountId!,
        createdByUid: ctx.uid,
        name: args.name as string,
        stages: args.stages as PipelineStage[],
        actor: agentActor(ctx, "create_pipeline"),
      });
      if (!id) throw new CapabilityUserError("This workspace wasn't found.");
      return { resultText: `Created the pipeline (id: ${id}).`, ref: { kind: "pipeline", id } };
    },
  },
  {
    name: "update_pipeline",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["agent"],
    menuLabel: "Rename a pipeline or change its stages",
    description: "Rename a pipeline and/or replace its stage list (read get_pipeline first). A stage left out is deleted, which is refused while deals sit in it.",
    parameters: {
      type: "object",
      properties: { pipelineId: pipelineIdParam, name: { type: "string" }, stages: stagesParam },
      required: ["pipelineId"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const pipelineId = str(raw, "pipelineId");
      if (!isDocId(pipelineId)) return { ok: false, error: "a pipelineId is required" };
      const f = pipelineFields(raw, false);
      if (!f.ok) return f;
      if (f.name === undefined && f.stages === undefined) return { ok: false, error: "give a name or stages" };
      return { ok: true, args: { pipelineId, ...(f.name !== undefined ? { name: f.name } : {}), ...(f.stages ? { stages: f.stages } : {}) } };
    },
    summarize: (args) => `Update the pipeline ${args.pipelineId}.`,
    execute: async (ctx, args) => {
      const pipeline = await tenantPipeline(ctx.subAccountId!, args.pipelineId);
      const done = await updatePipeline({
        subAccountId: ctx.subAccountId!,
        pipeline,
        name: args.name as string | undefined,
        stages: args.stages as PipelineStage[] | undefined,
        actor: agentActor(ctx, "update_pipeline"),
      });
      if (!done.ok) throw new CapabilityUserError(done.error);
      return { resultText: "Updated the pipeline.", ref: { kind: "pipeline", id: pipeline.id } };
    },
  },
  {
    name: "delete_pipeline",
    level: "sub-account",
    requiredRole: "subAccountAdmin",
    surfaces: ["agent"],
    approval: "hard_delete",
    menuLabel: "Delete a pipeline (a person approves)",
    description: "Delete a pipeline. Refused for the default pipeline and while any deal is in it. Queued for a sub-account admin to approve.",
    parameters: { type: "object", properties: { pipelineId: pipelineIdParam }, required: ["pipelineId"], additionalProperties: false },
    validate: (raw) => {
      const pipelineId = str(raw, "pipelineId");
      return isDocId(pipelineId) ? { ok: true, args: { pipelineId } } : { ok: false, error: "a pipelineId is required" };
    },
    summarize: () => "Delete a pipeline.",
    // Pipelines carry no territory: the approval is tenant-wide.
    approvalTarget: async (ctx, args) => {
      await tenantPipeline(ctx.subAccountId!, args.pipelineId);
      return { contactId: null, territoryId: null, scoped: false };
    },
    preview: async (ctx, args) => {
      const p = await tenantPipeline(ctx.subAccountId!, args.pipelineId);
      if (p.isDefault) throw new CapabilityUserError("The default pipeline can't be deleted.");
      const deals = await countDeals(ctx.subAccountId!, p.id);
      return [
        { label: "Delete pipeline", value: oneLine(p.name) || "(unnamed)" },
        ...recordProvenanceRows(p.id, p),
        { label: "Stages", value: describeStages(p.stages) },
        { label: "Deals in it", value: String(deals) },
        ...(deals ? [{ label: "Will fail", value: "Deals are still in this pipeline; move or delete them first." }] : []),
      ];
    },
    execute: async (ctx, args) => {
      const done = await deletePipeline(ctx.subAccountId!, await tenantPipeline(ctx.subAccountId!, args.pipelineId));
      if (!done.ok) throw new CapabilityUserError(done.error);
      return { resultText: "Deleted the pipeline.", ref: { kind: "pipeline", id: args.pipelineId as string } };
    },
  },
];
