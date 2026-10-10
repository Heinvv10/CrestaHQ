import "server-only";

import { isDocId } from "@/lib/server/doc-id";
import { getAdminDb } from "@/lib/firebase/admin";
import { createDealServerSide } from "@/lib/server/deals-service";
import { listPipelines, readPipelineStages } from "@/lib/pipelines/server";
import { dealPipelineId, dealStage } from "@/lib/pipelines/stages";
import type {
  DealPriority,
  PipelineStage,
  PipelineStageId,
} from "@/types/deals";
import { scopedDocs, territoryScopeFor } from "@/lib/ai-suite/territory-scope";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { oneLine } from "./text-safety";
import {
  str,
  STAGE_IDS,
  rethrowStageError,
  assertInTerritory,
  fmtMoney,
  agentActor,
} from "./helpers";

export const DEAL_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "find_deals",
    level: "sub-account",
    requiredRole: "subAccountMember",
    readonly: true,
    menuLabel: "Search this workspace's deals (by title or pipeline stage)",
    description:
      "Search this sub-account's deals by title fragment and/or pipeline stage. Use to answer questions about deals and ALWAYS use it to resolve a deal's id before move_deal_stage — never guess ids.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional title fragment to match.",
        },
        stage: {
          type: "string",
          description: `Optional pipeline stage id to filter by (default pipeline: ${STAGE_IDS.join(", ")}; other pipelines define their own).`,
        },
      },
      additionalProperties: false,
    },
    validate: (raw) => {
      const query = str(raw, "query").slice(0, 120);
      const stage = str(raw, "stage").slice(0, 40);
      if (!query && !stage) {
        return { ok: false, error: "a title fragment or a stage is required" };
      }
      return { ok: true, args: { query, stage } };
    },
    summarize: (args) =>
      `Search deals${args.query ? ` matching “${args.query}”` : ""}${
        args.stage ? ` in stage “${args.stage}”` : ""
      }.`,
    execute: async (ctx, args) => {
      const q = ((args.query as string) || "").toLowerCase();
      const stage = (args.stage as string) || "";
      const scope = await territoryScopeFor(ctx);
      const docs = await scopedDocs(
        scope,
        getAdminDb()
          .collection("deals")
          .where("subAccountId", "==", ctx.subAccountId!)
          .limit(500)
      );
      const matches = docs
        .filter((d) => {
          const data = d.data();
          if (stage && data.stageId !== stage) return false;
          if (
            q &&
            !String(data.title ?? "")
              .toLowerCase()
              .includes(q)
          )
            return false;
          return true;
        })
        .slice(0, 10);
      if (matches.length === 0) {
        return { resultText: "No deals matched." };
      }
      // Each label from the deal's OWN pipeline (read-only: no seeding).
      const pipelines = (
        await Promise.all(
          [...new Set(matches.map((d) => dealPipelineId(d.data())))].map(
            async (id) => ({
              id,
              stages: await readPipelineStages(ctx.subAccountId!, id),
            })
          )
        )
      ).filter((p): p is { id: string; stages: PipelineStage[] } => !!p.stages);
      const lines = matches.map((d) => {
        const data = d.data();
        const stageId = String(data.stageId ?? "");
        return `- ${data.title} — id: ${d.id}, stage: ${
          dealStage({ pipelineId: data.pipelineId, stageId }, pipelines)
            ?.label ?? stageId
        }, value: ${fmtMoney(
          typeof data.value === "number" ? data.value : 0,
          (data.currency as string) || "USD"
        )}, contactId: ${data.contactId ?? "none"}`;
      });
      return { resultText: `Deals (${matches.length}):\n${lines.join("\n")}` };
    },
  },
  {
    name: "create_deal",
    level: "sub-account",
    requiredRole: "subAccountMember",
    menuLabel: "Create a deal for a contact (title, value, pipeline stage)",
    description:
      "Create a deal on the pipeline for an existing contact. Resolve the contact's id with find_contacts first — never guess ids. Ask for the deal value if the user didn't give one.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Deal title, e.g. 'Kitchen renovation'.",
        },
        value: { type: "number", description: "Deal value (0 if unknown)." },
        currency: {
          type: "string",
          description: "Optional 3-letter currency code. Defaults to USD.",
        },
        contactId: {
          type: "string",
          description:
            "The contact's id, exactly as returned by find_contacts.",
        },
        contactName: {
          type: "string",
          description: "The contact's name, for the confirmation card.",
        },
        stage: {
          type: "string",
          description: `Optional starting stage id on the deal's pipeline (default pipeline: ${STAGE_IDS.join(", ")}, or a stage the admin added; other pipelines define their own — see list_pipelines). Defaults to 'new' on the default pipeline, else the named pipeline's first stage.`,
        },
        pipeline: {
          type: "string",
          description:
            "Optional pipeline name or id when the workspace runs several (e.g. 'Installs'). Omit for the default pipeline.",
        },
      },
      required: ["title", "value", "contactId", "contactName"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const title = str(raw, "title");
      if (!title) return { ok: false, error: "a deal title is required" };
      const rawValue = (raw as Record<string, unknown>)?.value;
      const value =
        typeof rawValue === "number"
          ? rawValue
          : typeof rawValue === "string"
            ? Number(rawValue)
            : NaN;
      if (!Number.isFinite(value) || value < 0 || value > 1_000_000_000) {
        return {
          ok: false,
          error: "the deal value must be a number (0 if unknown)",
        };
      }
      const contactId = str(raw, "contactId");
      if (!contactId) {
        return {
          ok: false,
          error:
            "the contact is required — I need to find them first (find_contacts)",
        };
      }
      const currency = (str(raw, "currency") || "USD").toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) {
        return {
          ok: false,
          error: "the currency must be a 3-letter code like USD",
        };
      }
      const pipeline = str(raw, "pipeline").slice(0, 60);
      const stage = (str(raw, "stage") || (pipeline ? "" : "new")).slice(0, 40);
      return {
        ok: true,
        args: {
          title,
          value,
          currency,
          contactId,
          contactName: str(raw, "contactName"),
          stage,
          pipeline,
        },
      };
    },
    summarize: (args) =>
      `Create a deal “${args.title}” (${fmtMoney(
        args.value as number,
        args.currency as string
      )}) for ${args.contactName}${
        args.pipeline ? ` in the “${args.pipeline}” pipeline` : ""
      }${args.stage ? ` at stage “${args.stage}”` : ""}.`,
    execute: async (ctx, args) => {
      // The contact id came from the model — verify it's in THIS workspace.
      const c = isDocId(args.contactId)
        ? await getAdminDb().doc(`contacts/${args.contactId}`).get()
        : null;
      if (!c?.exists || c.data()?.subAccountId !== ctx.subAccountId) {
        throw new CapabilityUserError(
          "That contact wasn't found in this workspace."
        );
      }
      const contactTerritory = c.data()?.territoryId;
      assertInTerritory(
        await territoryScopeFor(ctx),
        contactTerritory,
        "That contact"
      );
      // The pipeline (name or id) resolves against THIS sub-account's live
      // pipelines; the service then validates the stage against it.
      let pipelineId: string | undefined;
      let pipelineName = "";
      let stageId = args.stage as PipelineStageId;
      if (args.pipeline) {
        const want = (args.pipeline as string).toLowerCase();
        const all = await listPipelines(ctx.subAccountId!);
        const pipeline =
          all.find((p) => p.id === args.pipeline) ??
          all.find((p) => p.name.toLowerCase() === want);
        if (!pipeline) {
          throw new CapabilityUserError(
            `There's no pipeline called “${args.pipeline}” in this workspace (it has: ${all.map((p) => oneLine(p.name)).join(", ")}).`
          );
        }
        pipelineId = pipeline.id;
        if (!pipeline.isDefault) pipelineName = oneLine(pipeline.name);
        stageId ||= pipeline.stages[0]?.id ?? "";
      }
      const res = await createDealServerSide({
        subAccountId: ctx.subAccountId!,
        agencyId: ctx.agencyId,
        createdByUid: ctx.uid,
        mode: "live",
        source: "ai",
        title: args.title as string,
        value: args.value as number,
        currency: args.currency as string,
        contactId: args.contactId as string,
        stageId,
        pipelineId,
        priority: "medium" as DealPriority,
        // The deal lives in its contact's territory, as tasks/events do.
        territoryId:
          typeof contactTerritory === "string" ? contactTerritory : null,
        actor: agentActor(ctx, "create_deal"),
      }).catch(rethrowStageError);
      return {
        resultText: `Created the deal “${args.title}” (${fmtMoney(
          args.value as number,
          args.currency as string
        )}) for ${args.contactName} in ${res.stage.label}${
          pipelineName ? ` (${pipelineName} pipeline)` : ""
        }. You'll see it on the Pipeline board.`,
        ref: { kind: "deal", id: res.id },
        ...(res.held ? { held: res.held, holdFailures: res.holdFailures ?? [] } : {}),
      };
    },
  },
];
