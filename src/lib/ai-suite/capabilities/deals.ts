import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { createDealServerSide } from "@/lib/server/deals-service";
import {
  getStage,
  type DealPriority,
  type PipelineStageId,
} from "@/types/deals";
import { scopedDocs, territoryScopeFor } from "@/lib/ai-suite/territory-scope";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import {
  str,
  STAGE_IDS,
  rethrowStageError,
  assertInTerritory,
  fmtMoney,
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
        args.stage ? ` in ${getStage(args.stage as PipelineStageId).label}` : ""
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
      const lines = matches.map((d) => {
        const data = d.data();
        return `- ${data.title} — id: ${d.id}, stage: ${
          getStage(data.stageId as PipelineStageId).label
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
          description: `Optional starting stage id on the default pipeline (${STAGE_IDS.join(", ")}, or a stage the admin added). Defaults to 'new'.`,
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
      const stage = (str(raw, "stage") || "new").slice(0, 40);
      return {
        ok: true,
        args: {
          title,
          value,
          currency,
          contactId,
          contactName: str(raw, "contactName"),
          stage,
        },
      };
    },
    summarize: (args) =>
      `Create a deal “${args.title}” (${fmtMoney(
        args.value as number,
        args.currency as string
      )}) for ${args.contactName} in ${getStage(args.stage as PipelineStageId).label}.`,
    execute: async (ctx, args) => {
      // The contact id came from the model — verify it's in THIS workspace.
      const c = await getAdminDb()
        .doc(`contacts/${args.contactId as string}`)
        .get();
      if (!c.exists || c.data()?.subAccountId !== ctx.subAccountId) {
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
      // The service validates the stage against the default pipeline.
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
        stageId: args.stage as PipelineStageId,
        priority: "medium" as DealPriority,
        // The deal lives in its contact's territory, as tasks/events do.
        territoryId:
          typeof contactTerritory === "string" ? contactTerritory : null,
      }).catch(rethrowStageError);
      return {
        resultText: `Created the deal “${args.title}” (${fmtMoney(
          args.value as number,
          args.currency as string
        )}) for ${args.contactName} in ${
          res.stage.label
        }. You'll see it on the Pipeline board.`,
        ref: { kind: "deal", id: res.id },
      };
    },
  },
];
