import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { getBillingProvider } from "@/lib/billing/provider";
import { BillingError } from "@/lib/billing/errors";
import { assertSupportedCurrency } from "@/lib/paystack/billing-api";
import { billingStripeIsConfigured } from "@/lib/server/billing-service";
import { DEFAULT_ON_GATE_FIELDS } from "@/lib/comms/ai/gates";
import { isDocId } from "@/lib/server/doc-id";
import { PLAN_GATE_KEYS, PLAN_GATE_LABELS, type PlanGateKey } from "@/types/billing";
import { planAssignRefusal } from "./billing-plans";
import { fmtMoney } from "./helpers";
import { oneLine } from "./text-safety";
import { CapabilityNotFound, CapabilityUserError, type AiSuiteActionContext, type PreviewRow } from "./types";

/**
 * The agent surface of `assign_billing_plan` and `create_one_time_charge`
 * (AGENCY_AGENT_API_PLAN.md A4b): both are always an agency-level `spend`
 * row the agency owner approves. Their previews read the target and the
 * plan live and pin what the owner reviews; execute bills only those pins.
 */

export const NEEDS_APPROVAL = "Billing a client needs the agency owner's approval; propose it again.";

/** The agent's display labels are never stored: the approver reads the
 *  names from the records themselves, never an agent's word for them. */
export const withoutLabels = ({ subAccountName: _s, planName: _p, ...rest }: Record<string, unknown>) => rest;

const NOT_IN_AGENCY = "That sub-account wasn't found in this agency.";
const NO_PROVIDER = "No payment provider is configured on this deployment: approving fails and changes nothing.";

/** The gates that change who or what reaches the sub-account. Public API
 *  access only ever switches off here: switching it on is refused
 *  (planAssignRefusal), and a key reaches only sub-accounts that have it. */
const REACH: Partial<Record<PlanGateKey, string>> = {
  apiAccessEnabledByAgency: "changes reach: API and agent keys lose this sub-account",
  emailDomainEnabledByAgency: "changes reach: its own sending domain",
};

const gateList = (keys: PlanGateKey[]) =>
  keys.length ? keys.map((k) => (REACH[k] ? `${PLAN_GATE_LABELS[k]} (${REACH[k]})` : PLAN_GATE_LABELS[k])).join(", ") : "Nothing";

/** A currency the configured provider cannot settle, refused up front. */
export function currencyRefusal(currency: string): string | null {
  if (getBillingProvider().id !== "paystack") return null;
  try {
    assertSupportedCurrency(currency);
    return null;
  } catch (err) {
    if (err instanceof BillingError) return err.message;
    throw err;
  }
}

async function targetIn(ctx: AiSuiteActionContext, subAccountId: string) {
  const sub = await getAdminDb().doc(`subAccounts/${subAccountId}`).get();
  if (!sub.exists || sub.data()?.agencyId !== ctx.agencyId) throw new CapabilityUserError(NOT_IN_AGENCY);
  return sub;
}

/** assign_billing_plan's preview: the plan, price, gate diff and billing outcome, pinned. */
export async function assignPreview(
  ctx: AiSuiteActionContext,
  args: Record<string, unknown>
): Promise<{ rows: PreviewRow[]; pinned: Record<string, unknown> }> {
  const sub = await targetIn(ctx, args.subAccountId as string);
  const planId = args.planId;
  const planSnap = isDocId(planId) ? await getAdminDb().doc(`agencies/${ctx.agencyId}/plans/${planId}`).get() : null;
  if (!planSnap?.exists) throw new CapabilityNotFound("No billing plan with that id in this agency. Look it up with list_billing_plans.");
  const plan = planSnap.data()!;
  if (plan.status === "archived") throw new CapabilityUserError("This plan is archived: unarchive it or pick another.");
  const year = args.interval === "year";
  const price = year ? plan.priceAnnualCents : plan.priceMonthlyCents;
  if (typeof price !== "number") throw new CapabilityUserError("This plan doesn't offer annual billing: assign it monthly.");

  const data = sub.data() ?? {};
  const billing = data.billing as { stripeSubscriptionId?: unknown; status?: unknown } | null | undefined;
  const live = !!billing?.stripeSubscriptionId && (billing.status === "active" || billing.status === "past_due");
  // As execute judges it: the checkout path as if every gate were off.
  const refusal = planAssignRefusal((plan.gates ?? {}) as Record<string, unknown>, live ? data : {});
  if (refusal) throw new CapabilityUserError(refusal);

  const gates = Object.fromEntries(PLAN_GATE_KEYS.map((k) => [k, plan.gates?.[k] === true])) as Record<PlanGateKey, boolean>;
  const now = (k: PlanGateKey) => (typeof data[k] === "boolean" ? data[k] : DEFAULT_ON_GATE_FIELDS.has(k));
  // Only the gates the plan names are applied (applyFeatureGates skips the rest).
  const named = PLAN_GATE_KEYS.filter((k) => typeof plan.gates?.[k] === "boolean");
  const on = named.filter((k) => gates[k] && !now(k));
  const off = named.filter((k) => !gates[k] && now(k));

  const cur = String(plan.currency ?? "usd").toUpperCase();
  const per = year ? "per year" : "per month";
  const special = (args.specialPriceCents as number | null) ?? null;
  const provider = getBillingProvider();
  const billingLine = !billingStripeIsConfigured()
    ? NO_PROVIDER
    : !live
      ? "The client gets a checkout link; the workspace is behind an activation screen until they pay."
      : provider.planSwitchTiming === "period_end"
        ? "Features switch now; the new price starts at the next renewal."
        : "Switches the live subscription now, prorated.";
  return {
    rows: [
      { label: "Sub-account", value: oneLine(data.name ?? sub.id) },
      { label: "Plan", value: `“${oneLine(plan.name)}”` },
      {
        label: "Price",
        value: special === null
          ? `${fmtMoney(price / 100, cur)} ${per}`
          : `${fmtMoney(special / 100, cur)} ${per} (special price; the plan's is ${fmtMoney(price / 100, cur)})`,
      },
      { label: "Switches on", value: gateList(on) },
      { label: "Switches off", value: gateList(off) },
      { label: "Features change", value: live ? "Now" : "When the client pays" },
      { label: "Billing", value: billingLine },
    ],
    pinned: {
      planId,
      planName: String(plan.name ?? ""),
      priceCents: price,
      interval: year ? "year" : "month",
      specialPriceCents: special,
      currency: String(plan.currency ?? "usd"),
      gates,
    },
  };
}

/** create_one_time_charge's preview: the charge as the client will see it, pinned. */
export async function chargePreview(
  ctx: AiSuiteActionContext,
  args: Record<string, unknown>
): Promise<{ rows: PreviewRow[]; pinned: Record<string, unknown> }> {
  if (!billingStripeIsConfigured()) {
    throw new CapabilityUserError("No payment provider is configured on this deployment, so no charge can be created.");
  }
  const sub = await targetIn(ctx, args.subAccountId as string);
  const amountCents = args.amountCents as number;
  const currency = args.currency as string;
  return {
    rows: [
      { label: "Sub-account", value: oneLine(sub.data()?.name ?? sub.id) },
      { label: "Charge", value: `“${oneLine(args.description)}”` },
      { label: "Amount", value: fmtMoney(amountCents / 100, currency.toUpperCase()) },
      { label: "Payment", value: "One payment link for you to send the client; nothing is charged until they pay. Not a subscription." },
    ],
    pinned: { subAccountId: sub.id, description: args.description, amountCents, currency },
  };
}
