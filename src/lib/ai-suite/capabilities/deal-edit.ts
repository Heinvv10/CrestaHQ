import "server-only";

import { isDocId } from "@/lib/server/doc-id";
import { getAdminDb } from "@/lib/firebase/admin";
import { deleteDealServerSide, updateDealServerSide, type UpdateDealPatch } from "@/lib/server/deals-service";
import { DEAL_PRIORITIES, type DealPriority } from "@/types/deals";
import { CapabilityUserError, type AiSuiteCapability } from "./types";
import { agentActor, fmtMoney, rethrowStageError, str } from "./helpers";
import { hasUnsafeText, oneLine, UNSAFE_TEXT_MESSAGE } from "./text-safety";
import { recordProvenanceRows } from "./record-provenance";

/**
 * update_deal and delete_deal for API agents (AGENT_API_V1_PLAN.md, PR9).
 * update_deal edits a deal's own fields only — a stage move is
 * move_deal_stage, and `completed` is never taken: the app's own edit route
 * sends a review request when a Won deal is first completed, and an agent
 * must not be able to trigger that. Deleting a deal is always approved.
 */

const dealIdParam = { type: "string", description: "The deal's id (from find_deals)." };
const PRIORITIES = DEAL_PRIORITIES.map((p) => p.id);

/** The deal, re-anchored to the sub-account. */
async function tenantDeal(subAccountId: string, dealId: unknown): Promise<FirebaseFirestore.DocumentData> {
  const snap = isDocId(dealId) ? await getAdminDb().doc(`deals/${dealId}`).get() : null;
  const data = snap?.data();
  if (!data || data.subAccountId !== subAccountId) throw new CapabilityUserError("That deal wasn't found in this workspace.");
  return data;
}

/** The deal fields an agent may set; `completed` (and the rest) never read. */
function dealPatch(raw: unknown): { ok: true; patch: UpdateDealPatch } | { ok: false; error: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const patch: UpdateDealPatch = {};
  if (r.title !== undefined) {
    const title = typeof r.title === "string" ? r.title.trim() : "";
    if (!title || title.length > 200 || hasUnsafeText(title)) {
      return { ok: false, error: `title must be 1-200 characters of text, none that ${UNSAFE_TEXT_MESSAGE}` };
    }
    patch.title = title;
  }
  if (r.value !== undefined) {
    if (typeof r.value !== "number" || !Number.isFinite(r.value) || r.value < 0 || r.value > 1_000_000_000) {
      return { ok: false, error: "value must be a number from 0 to 1,000,000,000" };
    }
    patch.value = r.value;
  }
  if (r.currency !== undefined) {
    if (typeof r.currency !== "string" || !/^[A-Za-z]{3}$/.test(r.currency)) return { ok: false, error: "currency must be a 3-letter code" };
    patch.currency = r.currency.toUpperCase();
  }
  if (r.priority !== undefined) {
    if (!PRIORITIES.includes(r.priority as DealPriority)) return { ok: false, error: `priority must be one of ${PRIORITIES.join(", ")}` };
    patch.priority = r.priority as DealPriority;
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: "give at least one of title, value, currency, priority" };
  return { ok: true, patch };
}

export const DEAL_EDIT_CAPABILITIES: AiSuiteCapability[] = [
  {
    name: "update_deal",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["agent"],
    menuLabel: "Edit a deal's title, value, currency or priority",
    description:
      "Change a deal's title, value, currency or priority. To move it to another stage use move_deal_stage. It can't mark a deal completed.",
    parameters: {
      type: "object",
      properties: {
        dealId: dealIdParam,
        title: { type: "string" },
        value: { type: "number" },
        currency: { type: "string", description: "3-letter code." },
        priority: { type: "string", enum: PRIORITIES },
      },
      required: ["dealId"],
      additionalProperties: false,
    },
    validate: (raw) => {
      const dealId = str(raw, "dealId");
      if (!isDocId(dealId)) return { ok: false, error: "a dealId is required" };
      const p = dealPatch(raw);
      return p.ok ? { ok: true, args: { dealId, ...p.patch } } : p;
    },
    summarize: (args) => `Edit the deal ${args.dealId}.`,
    execute: async (ctx, args) => {
      const { dealId, ...patch } = args as unknown as { dealId: string } & UpdateDealPatch;
      await tenantDeal(ctx.subAccountId!, dealId);
      const done = await updateDealServerSide({
        dealId,
        userId: ctx.uid,
        expectedSubAccountId: ctx.subAccountId!,
        source: "ai",
        patch,
        actor: agentActor(ctx, "update_deal"),
      }).catch(rethrowStageError);
      if (!done) throw new CapabilityUserError("That deal wasn't found in this workspace.");
      return {
        resultText: "Updated the deal.",
        ref: { kind: "deal", id: dealId },
        ...(done.held ? { held: done.held, holdFailures: done.holdFailures ?? [] } : {}),
      };
    },
  },
  {
    name: "delete_deal",
    level: "sub-account",
    requiredRole: "subAccountMember",
    surfaces: ["agent"],
    approval: "hard_delete",
    menuLabel: "Delete a deal (a person approves)",
    description: "Delete a deal permanently. Queued for a person to approve.",
    parameters: { type: "object", properties: { dealId: dealIdParam }, required: ["dealId"], additionalProperties: false },
    validate: (raw) => {
      const dealId = str(raw, "dealId");
      return isDocId(dealId) ? { ok: true, args: { dealId } } : { ok: false, error: "a dealId is required" };
    },
    summarize: () => "Delete a deal.",
    // A deal carries its own territory: approvers are gated on it.
    approvalTarget: async (ctx, args) => {
      const d = await tenantDeal(ctx.subAccountId!, args.dealId);
      return { contactId: null, territoryId: (d.territoryId as string | null) ?? null, scoped: true };
    },
    preview: async (ctx, args) => {
      const d = await tenantDeal(ctx.subAccountId!, args.dealId);
      return [
        { label: "Delete deal", value: oneLine(d.title) || "(untitled)" },
        ...recordProvenanceRows(args.dealId as string, d),
        { label: "Value", value: fmtMoney(typeof d.value === "number" ? d.value : 0, (d.currency as string) || "USD") },
        { label: "Stage", value: String(d.stageId ?? "(none)") },
        { label: "Contact id", value: String(d.contactId ?? "(none)") },
      ];
    },
    execute: async (ctx, args) => {
      await tenantDeal(ctx.subAccountId!, args.dealId);
      if (!(await deleteDealServerSide({ dealId: args.dealId as string }))) {
        throw new CapabilityUserError("That deal wasn't found in this workspace.");
      }
      return { resultText: "Deleted the deal.", ref: { kind: "deal", id: args.dealId as string } };
    },
  },
];
