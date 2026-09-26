import "server-only";

import { isDocId } from "@/lib/server/doc-id";
import { getAdminDb } from "@/lib/firebase/admin";
import { updateDealServerSide } from "@/lib/server/deals-service";
import { askReviewIfNewlyCompleted } from "@/lib/server/deal-completion";
import { readPipelineStages } from "@/lib/pipelines/server";
import { dealPipelineId } from "@/lib/pipelines/stages";
import type { PipelineStage } from "@/types/deals";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { fmtMoney, rethrowStageError, str, toDate } from "./helpers";
import { oneLine } from "./text-safety";
import { recordProvenanceRows } from "./record-provenance";
import { reviewPlan } from "./deal-review-plan";

/**
 * mark_deal_completed for API agents (AGENT_API_V1_PLAN.md, PR9b). Marking
 * a Won deal completed can send the contact a Google review request, so a
 * person approves it (outbound): the preview shows the exact request, its
 * recipient and channel (deal-review-plan.ts); contact, number and text are
 * pinned; approve runs what the deal card's "completed" tick runs
 * (askReviewIfNewlyCompleted), with the Won check in the write's transaction.
 */

async function tenantDeal(subAccountId: string, dealId: unknown): Promise<FirebaseFirestore.DocumentData> {
  const data = isDocId(dealId) ? (await getAdminDb().doc(`deals/${dealId}`).get()).data() : undefined;
  if (!data || data.subAccountId !== subAccountId) throw new CapabilityUserError("That deal wasn't found in this workspace.");
  return data;
}

export const DEAL_COMPLETE_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "mark_deal_completed",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["agent"],
    approval: "outbound",
    menuLabel: "Mark a Won deal completed (a person approves; may send a review request)",
    description:
      "Mark a Won deal completed, as the deal card's tick does. That can send the contact a Google review request, so it is queued for a person to approve.",
    parameters: {
      type: "object",
      properties: { dealId: { type: "string", description: "The deal's id (from find_deals)." } },
      required: ["dealId"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const dealId = str(raw, "dealId");
      return isDocId(dealId) ? { ok: true, args: { dealId } } : { ok: false, error: "a dealId is required" };
    },
    summarize: () => "Mark a deal completed.",
    approvalTarget: async (ctx, args) => {
      const d = await tenantDeal(ctx.subAccountId!, args.dealId);
      return { contactId: null, territoryId: (d.territoryId as string | null) ?? null, scoped: true };
    },
    preview: async (ctx, args) => {
      const d = await tenantDeal(ctx.subAccountId!, args.dealId);
      if (d.completed === true) throw new CapabilityUserError("That deal is already completed.");
      const pipelineId = dealPipelineId(d);
      const pipelineDoc = (await getAdminDb().doc(`subAccounts/${ctx.subAccountId}/pipelines/${pipelineId}`).get()).data();
      const stages = (pipelineDoc?.stages as PipelineStage[] | undefined) ?? (await readPipelineStages(ctx.subAccountId!, pipelineId));
      const stage = stages?.find((s) => s.id === d.stageId);
      if (stage?.terminal !== "won") throw new CapabilityUserError("Only a Won deal can be marked completed.");
      const edited = toDate(pipelineDoc?.lastAgentEditAt);
      const plan = await reviewPlan(ctx.subAccountId!, d, Date.now());
      return {
        rows: [
          { label: "Mark completed", value: oneLine(d.title) || "(untitled)" },
          ...recordProvenanceRows(args.dealId as string, d),
          { label: "Stage", value: `${oneLine(stage.label)} (Won stage)` },
          ...(edited
            ? [{
                label: "Warning",
                value: `API agent ${String(pipelineDoc?.lastAgentEditKey ?? "(unknown key)")} last edited this pipeline at ${edited.toISOString()}: its stage names and which stage counts as Won may be the agent's.`,
              }]
            : []),
          { label: "Value", value: fmtMoney(typeof d.value === "number" ? d.value : 0, (d.currency as string) || "USD") },
          ...plan.rows,
        ],
        pinned: { dealId: args.dealId, contactId: plan.contactId, phone: plan.phone, channel: plan.channel, body: plan.body },
      };
    },
    execute: async (ctx, args) => {
      const before = await tenantDeal(ctx.subAccountId!, args.dealId);
      const pinned = ctx.approved?.pinned ?? {};
      const plan = await reviewPlan(ctx.subAccountId!, before, Date.now());
      if (plan.contactId !== pinned.contactId || plan.phone !== pinned.phone || plan.channel !== pinned.channel || plan.body !== pinned.body) {
        throw new CapabilityUserError("The deal's contact, their number or the review request changed since this was reviewed; nothing was changed.");
      }
      const result = await updateDealServerSide({
        dealId: args.dealId as string,
        userId: ctx.uid,
        expectedSubAccountId: ctx.subAccountId!,
        source: "ai",
        patch: { completed: true },
        // Checked in the write's transaction: the stage may have moved since.
        guard: (existing, terminal) => {
          if (terminal !== "won") throw new CapabilityUserError("The deal is no longer on a Won stage; it was not marked completed.");
          if (((existing.contactId as string | null) ?? null) !== pinned.contactId) {
            throw new CapabilityUserError("The deal's contact changed since this was reviewed; it was not marked completed.");
          }
        },
      }).catch(rethrowStageError);
      if (!result) throw new CapabilityUserError("That deal wasn't found in this workspace.");
      // Only a reviewed request is sent, and the send itself refuses a number
      // or channel that changed after this point.
      if (plan.channel) {
        askReviewIfNewlyCompleted({ before, completed: true, result, expect: { phone: plan.phone, channel: plan.channel } });
      }
      return { resultText: "Marked the deal completed.", ref: { kind: "deal", id: args.dealId as string } };
    },
  },
];
