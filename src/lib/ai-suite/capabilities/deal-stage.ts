import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { updateDealServerSide } from "@/lib/server/deals-service";
import { territoryScopeFor } from "@/lib/ai-suite/territory-scope";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import {
  str,
  STAGE_IDS,
  rethrowStageError,
  assertInTerritory,
  agentActor,
} from "./helpers";

export const DEAL_STAGE_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "move_deal_stage",
    level: "sub-account",
    requiredRole: "subAccountMember",
    menuLabel: "Move a deal to another pipeline stage (including Won / Lost)",
    description:
      "Move an existing deal to a different pipeline stage. Resolve the deal's id with find_deals first — never guess ids. When moving to 'lost', ask the user for a short lost reason.",
    parameters: {
      type: "object",
      properties: {
        dealId: {
          type: "string",
          description: "The deal's id, exactly as returned by find_deals.",
        },
        dealTitle: {
          type: "string",
          description: "The deal's title, for the confirmation card.",
        },
        stage: {
          type: "string",
          description: `A stage id of the deal's own pipeline (the default pipeline's are ${STAGE_IDS.join(", ")}; other pipelines define their own). Its Won / Lost stages close the deal.`,
        },
        lostReason: {
          type: "string",
          description: "Short reason, only when moving to the pipeline's Lost stage.",
        },
      },
      required: ["dealId", "dealTitle", "stage"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const dealId = str(raw, "dealId");
      if (!dealId) {
        return {
          ok: false,
          error:
            "the deal id is required — I need to find it first (find_deals)",
        };
      }
      const stage = str(raw, "stage").slice(0, 40);
      if (!stage) return { ok: false, error: "a stage id is required" };
      return {
        ok: true,
        args: {
          dealId,
          dealTitle: str(raw, "dealTitle"),
          stage,
          lostReason: str(raw, "lostReason").slice(0, 300),
        },
      };
    },
    // The stage label lives on the deal's pipeline, which this pure
    // summary cannot read — show the id; the result text shows the label.
    summarize: (args) =>
      `Move the deal “${args.dealTitle || args.dealId}” to stage "${args.stage}"${
        args.lostReason ? ` (reason: ${args.lostReason})` : ""
      }.`,
    execute: async (ctx, args) => {
      // The deal id came from the model — verify it's in THIS workspace.
      const snap = await getAdminDb()
        .doc(`deals/${args.dealId as string}`)
        .get();
      if (!snap.exists || snap.data()?.subAccountId !== ctx.subAccountId) {
        throw new CapabilityUserError(
          "That deal wasn't found in this workspace."
        );
      }
      assertInTerritory(
        await territoryScopeFor(ctx),
        snap.data()?.territoryId,
        "That deal"
      );
      // The service validates the stage against the deal's OWN pipeline
      // and only keeps lostReason when landing on its Lost stage.
      const moved = await updateDealServerSide({
        dealId: snap.id,
        userId: ctx.uid,
        expectedSubAccountId: ctx.subAccountId!,
        source: "ai",
        patch: {
          stageId: args.stage as string,
          lostReason: (args.lostReason as string) || null,
        },
        actor: agentActor(ctx, "move_deal_stage"),
      }).catch(rethrowStageError);
      if (!moved) {
        throw new CapabilityUserError(
          "That deal wasn't found in this workspace."
        );
      }
      const title =
        (snap.data()?.title as string) || (args.dealTitle as string);
      return {
        resultText: `Moved “${title}” to ${moved.stage.label}.`,
        ref: { kind: "deal", id: snap.id },
        ...(moved.held ? { held: moved.held } : {}),
      };
    },
  },
];
