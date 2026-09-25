import "server-only";

import { isDocId } from "@/lib/server/doc-id";
import { getAdminDb } from "@/lib/firebase/admin";
import { updateDealServerSide } from "@/lib/server/deals-service";
import { askReviewIfNewlyCompleted } from "@/lib/server/deal-completion";
import { readPipelineStages } from "@/lib/pipelines/server";
import { dealPipelineId } from "@/lib/pipelines/stages";
import { resolveReviewUrl } from "@/lib/reviews/canonical-url";
import { normalizeReviewChannel } from "@/lib/reviews/constants";
import type { SubAccountDoc } from "@/types";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { fmtMoney, rethrowStageError, str } from "./helpers";
import { oneLine } from "./text-safety";
import { recordProvenanceRows } from "./record-provenance";
import { masked } from "./conversation-send-support";

/**
 * mark_deal_completed for API agents (AGENT_API_V1_PLAN.md, PR9b). Marking
 * a Won deal completed can send the contact a Google review request, so a
 * person approves it (outbound): the preview names the recipient and the
 * channel, the contact and number are pinned, and approve runs exactly what
 * the deal card's "completed" tick runs (askReviewIfNewlyCompleted).
 */

async function tenantDeal(subAccountId: string, dealId: unknown): Promise<FirebaseFirestore.DocumentData> {
  const data = isDocId(dealId) ? (await getAdminDb().doc(`deals/${dealId}`).get()).data() : undefined;
  if (!data || data.subAccountId !== subAccountId) throw new CapabilityUserError("That deal wasn't found in this workspace.");
  return data;
}

/** The deal's contact in this sub-account, or null. */
async function dealContact(subAccountId: string, contactId: unknown) {
  const data = isDocId(contactId) ? (await getAdminDb().doc(`contacts/${contactId}`).get()).data() : undefined;
  return data && data.subAccountId === subAccountId ? data : null;
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
      const stages = await readPipelineStages(ctx.subAccountId!, dealPipelineId(d));
      const stage = stages?.find((s) => s.id === d.stageId);
      if (stage?.terminal !== "won") throw new CapabilityUserError("Only a Won deal can be marked completed.");
      const [contact, sub] = await Promise.all([
        dealContact(ctx.subAccountId!, d.contactId),
        getAdminDb().doc(`subAccounts/${ctx.subAccountId}`).get().then((s) => s.data() as SubAccountDoc | undefined),
      ]);
      const phone = typeof contact?.phone === "string" ? contact.phone : "";
      const cfg = sub?.googleReviewConfig;
      const on = !!cfg?.enabled && cfg.triggerOnDealCompleted === true && !!resolveReviewUrl(sub).configured;
      const channel = normalizeReviewChannel(cfg?.channel) === "sms" ? "SMS" : "WhatsApp";
      const review = !on
        ? "None: review requests for completed deals are off in this workspace."
        : !contact || !phone
          ? "None: the deal's contact has no phone number."
          : `Sent to ${oneLine(contact.name) || "(unnamed)"} (${masked("sms", phone)}) by ${channel}, unless quiet hours, an opt-out or the review cooldown stop it.`;
      return {
        rows: [
          { label: "Mark completed", value: oneLine(d.title) || "(untitled)" },
          ...recordProvenanceRows(args.dealId as string, d),
          { label: "Stage", value: oneLine(stage.label) },
          { label: "Value", value: fmtMoney(typeof d.value === "number" ? d.value : 0, (d.currency as string) || "USD") },
          { label: "Review request", value: review },
        ],
        pinned: { dealId: args.dealId, contactId: (d.contactId as string | null) ?? null, phone },
      };
    },
    execute: async (ctx, args) => {
      const before = await tenantDeal(ctx.subAccountId!, args.dealId);
      const pinned = ctx.approved?.pinned ?? {};
      const contact = await dealContact(ctx.subAccountId!, before.contactId);
      const phone = typeof contact?.phone === "string" ? contact.phone : "";
      if (((before.contactId as string | null) ?? null) !== pinned.contactId || phone !== pinned.phone) {
        throw new CapabilityUserError("The deal's contact or their number changed since this was reviewed; nothing was changed.");
      }
      const result = await updateDealServerSide({
        dealId: args.dealId as string,
        userId: ctx.uid,
        expectedSubAccountId: ctx.subAccountId!,
        source: "ai",
        patch: { completed: true },
      }).catch(rethrowStageError);
      if (!result) throw new CapabilityUserError("That deal wasn't found in this workspace.");
      askReviewIfNewlyCompleted({ before, completed: true, result });
      return { resultText: "Marked the deal completed.", ref: { kind: "deal", id: args.dealId as string } };
    },
  },
];
