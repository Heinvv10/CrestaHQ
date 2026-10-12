import "server-only";

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getBillingProvider } from "@/lib/billing/provider";
import { applyFeatureGates } from "@/lib/server/feature-gates-service";
import {
  buildChargeCheckoutUrl,
  buildCheckoutUrl,
  issueChargeToken,
  issueCheckoutToken,
} from "@/lib/billing/token";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import {
  PLAN_GATE_KEYS,
  type BillingChargeDoc,
  type BillingChargeResponse,
  type BillingChargeStatus,
  type BillingInterval,
  type BillingPlanDoc,
  type BillingPlanResponse,
  type PlanGates,
  type SubAccountBillingStatus,
} from "@/types/billing";
import { BillingError } from "@/lib/billing/errors";
import {
  chargesCollection,
  isRetiring,
  readBilling,
  recordBillingEvent,
} from "@/lib/server/billing-lifecycle";
import {
  SUB_ACCOUNT_CHARGE_KIND,
  SUB_ACCOUNT_PLAN_KIND,
} from "@/lib/billing/kinds";
import { runAfterResponse } from "@/lib/server/after-response";

/**
 * Client Billing v1 service — the single write path for agency plans
 * (`agencies/{agencyId}/plans/{planId}`) and per-sub-account billing state
 * (`subAccounts/{id}.billing`). Charges run on the deployment's own Stripe
 * account (one agency per deployment — no Connect). Auth stays with the
 * callers (owner-gated routes + the signature-verified Stripe webhook);
 * this module trusts its inputs.
 *
 * Stripe linkage:
 *   - plan create  → Product + recurring monthly Price
 *   - price edit   → NEW Price (immutable), old one deactivated; existing
 *                    subscriptions keep the price they signed up at
 *   - special price → one-off Price on the plan's Product, scoped to one
 *                    sub-account via metadata
 *   - checkout     → mode:"subscription", `metadata.kind = "subAccountPlan"`
 *                    stamped on BOTH the session and the subscription so the
 *                    webhook can route without ever colliding with the
 *                    legacy founders / user-subscription branches
 */

export { SUB_ACCOUNT_CHARGE_KIND, SUB_ACCOUNT_PLAN_KIND };

/** Stripe's practical floor for a recurring charge, in cents. */
const MIN_PRICE_CENTS = 100;
const MAX_PRICE_CENTS = 100_000_000;

/**
 * Whether Client Billing can talk to its payment provider. Named for Stripe
 * historically; it now asks the configured provider. Kept as an exported
 * function so routes and the assistant keep importing it from here.
 */
export function billingStripeIsConfigured(): boolean {
  return getBillingProvider().isConfigured();
}

export { BillingError };

function plansCollection(agencyId: string) {
  return getAdminDb().collection(`agencies/${agencyId}/plans`);
}


function tsToIso(value: unknown): string | null {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return null;
}

function serializePlan(
  id: string,
  data: FirebaseFirestore.DocumentData,
): BillingPlanResponse {
  const gates = {} as PlanGates;
  for (const key of PLAN_GATE_KEYS) {
    gates[key] = data.gates?.[key] === true;
  }
  return {
    id,
    name: String(data.name ?? ""),
    description: (data.description as string | null) ?? null,
    priceMonthlyCents: Number(data.priceMonthlyCents ?? 0),
    priceAnnualCents:
      data.priceAnnualCents != null ? Number(data.priceAnnualCents) : null,
    currency: String(data.currency ?? "usd"),
    gates,
    quotas: (data.quotas as BillingPlanResponse["quotas"]) ?? null,
    rates: (data.rates as BillingPlanResponse["rates"]) ?? null,
    status: data.status === "archived" ? "archived" : "active",
    createdAt: tsToIso(data.createdAt),
    updatedAt: tsToIso(data.updatedAt),
  };
}


export function validatePlanPricing(
  priceMonthlyCents: unknown,
  currency: unknown,
): { priceMonthlyCents: number; currency: string } {
  if (
    typeof priceMonthlyCents !== "number" ||
    !Number.isInteger(priceMonthlyCents) ||
    priceMonthlyCents < MIN_PRICE_CENTS ||
    priceMonthlyCents > MAX_PRICE_CENTS
  ) {
    throw new BillingError(
      `priceMonthlyCents must be an integer between ${MIN_PRICE_CENTS} and ${MAX_PRICE_CENTS}.`,
    );
  }
  const cur = typeof currency === "string" ? currency.trim().toLowerCase() : "";
  if (!/^[a-z]{3}$/.test(cur)) {
    throw new BillingError(
      'currency must be a 3-letter ISO code (e.g. "usd", "aud").',
    );
  }
  return { priceMonthlyCents, currency: cur };
}

/**
 * Validate the OPTIONAL annual price. Accepts `null`/`undefined` (monthly-only)
 * or an integer in the Stripe range. Returns the normalized value: `undefined`
 * means "no change" (edit path), `null` means "monthly-only", a number sets it.
 */
export function validateAnnualPrice(
  priceAnnualCents: unknown,
): number | null | undefined {
  if (priceAnnualCents === undefined) return undefined;
  if (priceAnnualCents === null) return null;
  if (
    typeof priceAnnualCents !== "number" ||
    !Number.isInteger(priceAnnualCents) ||
    priceAnnualCents < MIN_PRICE_CENTS ||
    priceAnnualCents > MAX_PRICE_CENTS
  ) {
    throw new BillingError(
      `priceAnnualCents must be null or an integer between ${MIN_PRICE_CENTS} and ${MAX_PRICE_CENTS}.`,
    );
  }
  return priceAnnualCents;
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export async function listPlansForAgency(
  agencyId: string,
): Promise<BillingPlanResponse[]> {
  const snap = await plansCollection(agencyId).get();
  return snap.docs
    .map((d) => serializePlan(d.id, d.data()))
    .sort((a, b) => a.priceMonthlyCents - b.priceMonthlyCents);
}

export async function createPlanForAgency(input: {
  agencyId: string;
  name: string;
  description: string | null;
  priceMonthlyCents: number;
  /** Optional annual price; null = monthly-only. */
  priceAnnualCents: number | null;
  currency: string;
  gates: PlanGates;
  /** Usage Metering v1 — included monthly quotas; null = unlimited. */
  quotas?: import("@/types/usage").UsageQuotas | null;
  /** v1.5 — overage sell rates (cents); null = none. */
  rates?: import("@/types/usage").UsageRates | null;
}): Promise<BillingPlanResponse> {
  if (!billingStripeIsConfigured()) {
    throw new BillingError(
      "Stripe isn't configured on this deployment. Set STRIPE_SECRET_KEY to create plans.",
      503,
    );
  }
  const provider = getBillingProvider();
  const ref = plansCollection(input.agencyId).doc();

  const { productId, monthlyPriceId, annualPriceId } = await provider.createPlan({
    agencyId: input.agencyId,
    planId: ref.id,
    name: input.name,
    description: input.description,
    currency: input.currency,
    priceMonthlyCents: input.priceMonthlyCents,
    priceAnnualCents: input.priceAnnualCents,
  });

  await ref.set({
    id: ref.id,
    agencyId: input.agencyId,
    name: input.name,
    description: input.description,
    priceMonthlyCents: input.priceMonthlyCents,
    priceAnnualCents: input.priceAnnualCents,
    currency: input.currency,
    gates: input.gates,
    quotas: input.quotas ?? null,
    rates: input.rates ?? null,
    status: "active",
    stripeProductId: productId,
    stripePriceId: monthlyPriceId,
    stripeAnnualPriceId: annualPriceId,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  const snap = await ref.get();
  return serializePlan(ref.id, snap.data() ?? {});
}

export async function updatePlanForAgency(input: {
  agencyId: string;
  planId: string;
  name?: string;
  description?: string | null;
  priceMonthlyCents?: number;
  /** undefined = no change; null = remove annual; number = set/change annual. */
  priceAnnualCents?: number | null;
  gates?: PlanGates;
  /** undefined = no change; null = clear (unlimited); object = set. */
  quotas?: import("@/types/usage").UsageQuotas | null;
  /** undefined = no change; null = clear; object = set. */
  rates?: import("@/types/usage").UsageRates | null;
  status?: "active" | "archived";
}): Promise<BillingPlanResponse> {
  const ref = plansCollection(input.agencyId).doc(input.planId);
  const snap = await ref.get();
  if (!snap.exists) throw new BillingError("Plan not found", 404);
  const plan = snap.data() as BillingPlanDoc & Record<string, unknown>;

  const updates: Record<string, unknown> = {
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (typeof input.name === "string") updates.name = input.name;
  if (input.description !== undefined) updates.description = input.description;
  if (input.gates) updates.gates = input.gates;
  if (input.quotas !== undefined) updates.quotas = input.quotas;
  if (input.rates !== undefined) updates.rates = input.rates;
  if (input.status) updates.status = input.status;

  const provider = billingStripeIsConfigured() ? getBillingProvider() : null;

  // Price change → mint a NEW Stripe Price and deactivate the old one.
  // Existing subscriptions keep the price they signed up at (standard
  // Stripe behavior); only new checkouts see the new amount.
  if (
    typeof input.priceMonthlyCents === "number" &&
    input.priceMonthlyCents !== plan.priceMonthlyCents
  ) {
    if (!provider || !plan.stripeProductId) {
      throw new BillingError(
        "Stripe isn't configured — can't change the plan price.",
        503,
      );
    }
    const { priceId } = await provider.createPrice({
      productId: plan.stripeProductId,
      productName: (updates.name as string | undefined) ?? plan.name,
      unitAmountCents: input.priceMonthlyCents,
      currency: plan.currency,
      interval: "month",
      metadata: { planId: input.planId },
    });
    if (plan.stripePriceId) {
      await provider
        .deactivatePrice(plan.stripePriceId)
        .catch((err) =>
          console.warn("[billing] failed to deactivate old price", err),
        );
    }
    updates.priceMonthlyCents = input.priceMonthlyCents;
    updates.stripePriceId = priceId;
  }

  // Annual price change — add, change, or remove the interval=year Price.
  // undefined = untouched; null = remove (monthly-only); number = set/change.
  const currentAnnual = (plan.priceAnnualCents as number | null | undefined) ?? null;
  if (
    input.priceAnnualCents !== undefined &&
    input.priceAnnualCents !== currentAnnual
  ) {
    if (!provider || !plan.stripeProductId) {
      throw new BillingError(
        "Stripe isn't configured — can't change the annual price.",
        503,
      );
    }
    if (input.priceAnnualCents === null) {
      // Remove annual: deactivate the old yearly Price, clear the fields.
      if (plan.stripeAnnualPriceId) {
        await provider
          .deactivatePrice(plan.stripeAnnualPriceId)
          .catch((err) =>
            console.warn("[billing] failed to deactivate annual price", err),
          );
      }
      updates.priceAnnualCents = null;
      updates.stripeAnnualPriceId = null;
    } else {
      // Set or change annual: mint a new yearly Price, deactivate the old one.
      const annual = await provider.createPrice({
        productId: plan.stripeProductId,
        productName: (updates.name as string | undefined) ?? plan.name,
        unitAmountCents: input.priceAnnualCents,
        currency: plan.currency,
        interval: "year",
        metadata: { planId: input.planId, interval: "year" },
      });
      if (plan.stripeAnnualPriceId) {
        await provider
          .deactivatePrice(plan.stripeAnnualPriceId)
          .catch((err) =>
            console.warn("[billing] failed to deactivate old annual price", err),
          );
      }
      updates.priceAnnualCents = input.priceAnnualCents;
      updates.stripeAnnualPriceId = annual.priceId;
    }
  }

  // Keep the Stripe Product's display fields in sync (best-effort).
  if (
    provider &&
    plan.stripeProductId &&
    (typeof input.name === "string" || input.description !== undefined)
  ) {
    await provider
      .updateProduct(plan.stripeProductId, {
        ...(typeof input.name === "string" ? { name: input.name } : {}),
        ...(input.description !== undefined
          ? { description: input.description ?? "" }
          : {}),
      })
      .catch((err) =>
        console.warn("[billing] failed to sync Stripe product", err),
      );
  }

  // Archive → deactivate the standard price(s) so no new checkout can use them.
  if (input.status === "archived" && provider) {
    if (plan.stripePriceId) {
      await provider
        .deactivatePrice(plan.stripePriceId)
        .catch((err) =>
          console.warn("[billing] failed to deactivate archived price", err),
        );
    }
    if (plan.stripeAnnualPriceId) {
      await provider
        .deactivatePrice(plan.stripeAnnualPriceId)
        .catch((err) =>
          console.warn(
            "[billing] failed to deactivate archived annual price",
            err,
          ),
        );
    }
  }

  await ref.update(updates);

  // Gate edits propagate to every sub-account currently ON this plan —
  // the plan is the source of truth for a managed client's gates. Comped /
  // unmanaged sub-accounts are untouched.
  if (input.gates) {
    const subs = await getAdminDb()
      .collection("subAccounts")
      .where("billing.planId", "==", input.planId)
      .get();
    for (const doc of subs.docs) {
      if (doc.data().agencyId !== input.agencyId) continue;
      const status = doc.data().billing?.status as
        | SubAccountBillingStatus
        | undefined;
      // Pending clients get gates at activation; everyone else re-applies now.
      if (status === "active" || status === "past_due") {
        await applyFeatureGates(doc.id, input.gates).catch((err) =>
          console.warn(
            `[billing] gate re-apply failed for sub-account ${doc.id}`,
            err,
          ),
        );
      }
    }
  }

  const updated = await ref.get();
  return serializePlan(ref.id, updated.data() ?? {});
}

async function getPlanOrThrow(
  agencyId: string,
  planId: string,
): Promise<BillingPlanDoc> {
  const snap = await plansCollection(agencyId).doc(planId).get();
  if (!snap.exists) throw new BillingError("Plan not found", 404);
  return { ...(snap.data() as BillingPlanDoc), id: snap.id };
}

// ---------------------------------------------------------------------------
// Assignment / comp / checkout links
// ---------------------------------------------------------------------------

async function getSubInAgencyOrThrow(agencyId: string, subAccountId: string) {
  const ref = getAdminDb().doc(`subAccounts/${subAccountId}`);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.agencyId !== agencyId) {
    throw new BillingError("Sub-account not found", 404);
  }
  return { ref, data: snap.data() as Record<string, unknown> };
}


/**
 * Resolve the Stripe Price a checkout/subscription should use: the plan's
 * standard price, or a freshly-minted one-off "special price" scoped to
 * this sub-account (GHL's per-client Special Price).
 */
async function resolveStripePrice(
  plan: BillingPlanDoc,
  subAccountId: string,
  specialPriceCents: number | null,
  interval: BillingInterval,
): Promise<string> {
  if (!plan.stripeProductId) {
    throw new BillingError(
      "This plan has no Stripe product — recreate it with Stripe configured.",
      500,
    );
  }
  const basePriceId =
    interval === "year" ? plan.stripeAnnualPriceId : plan.stripePriceId;
  if (interval === "year" && !basePriceId) {
    throw new BillingError(
      "This plan has no annual price — add one on the plan, or assign it monthly.",
    );
  }
  if (!basePriceId) {
    throw new BillingError(
      "This plan has no Stripe price — recreate it with Stripe configured.",
      500,
    );
  }
  if (specialPriceCents === null) return basePriceId;
  // One-off special price minted at the SAME interval so the cadence matches.
  const { priceId } = await getBillingProvider().createPrice({
    productId: plan.stripeProductId,
    productName: plan.name,
    unitAmountCents: specialPriceCents,
    currency: plan.currency,
    interval,
    metadata: {
      planId: plan.id,
      specialForSubAccountId: subAccountId,
      interval,
    },
  });
  return priceId;
}

/** The gates a plan names, with their values: what applyFeatureGates applies. */
export function namedGates(gates: unknown): Record<string, boolean> {
  return Object.fromEntries(
    Object.entries((gates ?? {}) as Record<string, unknown>).filter(
      (e): e is [string, boolean] => typeof e[1] === "boolean",
    ),
  );
}

export interface AssignPlanResult {
  status: SubAccountBillingStatus;
  /** Fresh checkout URL (only when the sub-account still needs to pay). */
  checkoutUrl: string | null;
}

/**
 * Assign (or switch) a plan.
 *
 *  - No live subscription → billing goes "pending" + a fresh checkout link
 *    is minted. Gates apply at activation, not before.
 *  - Live subscription (active/past_due) → the Stripe subscription's single
 *    item is moved to the new price (prorated) and the new plan's gates
 *    apply immediately.
 */
export async function assignPlanToSubAccount(input: {
  agencyId: string;
  subAccountId: string;
  planId: string;
  specialPriceCents: number | null;
  /** Billing cadence the agency picked. Defaults to monthly. */
  interval?: BillingInterval;
  /**
   * An approved agent proposal's pins: the plan's price for `interval` and
   * the gates it names, with their values, as the owner reviewed them (a
   * gate named `false` switches off; an unnamed one is left alone). A plan
   * that differs is refused at this function's own plan read, before any
   * provider call or write. The owner UI passes neither.
   */
  expectedPriceCents?: number;
  expectedGates?: Record<string, boolean>;
}): Promise<AssignPlanResult> {
  if (!billingStripeIsConfigured()) {
    throw new BillingError(
      "Stripe isn't configured on this deployment. Set STRIPE_SECRET_KEY first.",
      503,
    );
  }
  const interval: BillingInterval = input.interval === "year" ? "year" : "month";
  const plan = await getPlanOrThrow(input.agencyId, input.planId);
  if (input.expectedPriceCents !== undefined || input.expectedGates !== undefined) {
    const price = interval === "year" ? plan.priceAnnualCents : plan.priceMonthlyCents;
    const gates = namedGates(plan.gates);
    const expected = namedGates(input.expectedGates);
    const keys = new Set([...Object.keys(gates), ...Object.keys(expected)]);
    if (price !== input.expectedPriceCents || [...keys].some((k) => gates[k] !== expected[k])) {
      throw new BillingError(
        "pinned_mismatch: the plan's price or features changed after this was approved. Nothing was charged; propose it again.",
        409,
      );
    }
  }
  if (plan.status !== "active") {
    throw new BillingError("This plan is archived — unarchive it or pick another.");
  }
  if (interval === "year" && plan.priceAnnualCents == null) {
    throw new BillingError(
      "This plan doesn't offer annual billing — add an annual price or assign it monthly.",
    );
  }
  if (input.specialPriceCents !== null) {
    if (
      !Number.isInteger(input.specialPriceCents) ||
      input.specialPriceCents < MIN_PRICE_CENTS ||
      input.specialPriceCents > MAX_PRICE_CENTS
    ) {
      throw new BillingError("specialPriceCents is out of range.");
    }
  }

  const { ref, data } = await getSubInAgencyOrThrow(
    input.agencyId,
    input.subAccountId,
  );
  const billing = readBilling(data);
  const basePriceCents =
    interval === "year"
      ? (plan.priceAnnualCents as number)
      : plan.priceMonthlyCents;
  const priceCents = input.specialPriceCents ?? basePriceCents;
  const stripePriceId = await resolveStripePrice(
    plan,
    input.subAccountId,
    input.specialPriceCents,
    interval,
  );

  const hasLiveSubscription =
    !!billing?.stripeSubscriptionId &&
    (billing.status === "active" || billing.status === "past_due");

  if (hasLiveSubscription) {
    // Plan switch on a live subscription. The timing comes from the provider,
    // not from here: Stripe prorates the difference, Paystack cannot prorate
    // at all and applies the new price at renewal. Choosing on the caller's
    // behalf would misprice on whichever provider it guessed wrong.
    const provider = getBillingProvider();
    // Paystack replaces the subscription: the old one is disabled before this
    // call returns and the new code is stored, and its disable webhook can
    // land in between. Marked so that webhook cannot cancel a paying client.
    // (Stripe keeps the same subscription, so there is nothing to mark.)
    //
    // The mark is also the switch's lock, claimed in a transaction: two
    // switches at once (a double-click, two admins, a retry after a timeout)
    // would each open a replacement, and one of them would bill untracked.
    const replaces = provider.id === "paystack";
    if (replaces) {
      await getAdminDb().runTransaction(async (tx) => {
        const fresh = readBilling(((await tx.get(ref)).data() ?? {}) as Record<string, unknown>);
        if (
          fresh?.stripeSubscriptionId !== billing.stripeSubscriptionId ||
          (fresh?.retiringSubscriptionId &&
            isRetiring(fresh, fresh.retiringSubscriptionId))
        ) {
          throw new BillingError(
            "A plan switch for this workspace is already in progress — it can take up to 10 minutes to clear. Check the plan before trying again.",
            409,
          );
        }
        tx.update(ref, {
          "billing.retiringSubscriptionId": billing.stripeSubscriptionId,
          "billing.retiringSince": FieldValue.serverTimestamp(),
        });
      });
    }
    let subscriptionId: string;
    try {
      ({ subscriptionId } = await provider.switchSubscriptionPlan({
        subscriptionId: billing.stripeSubscriptionId as string,
        priceId: stripePriceId,
        timing: provider.planSwitchTiming,
        metadata: {
          kind: SUB_ACCOUNT_PLAN_KIND,
          agencyId: input.agencyId,
          subAccountId: input.subAccountId,
          planId: plan.id,
        },
      }));
    } catch (err) {
      // The old subscription is still the live one: its events count again.
      if (replaces) {
        await ref.update({ "billing.retiringSubscriptionId": null, "billing.retiringSince": null });
      }
      throw err;
    }

    // Comped while the switch ran (comp refuses while the mark holds, but a
    // comp that cancelled first can land before it): never write a plan and
    // a live subscription over a comped client.
    const comped = await getAdminDb().runTransaction(async (tx) => {
      const fresh = readBilling(((await tx.get(ref)).data() ?? {}) as Record<string, unknown>);
      if (fresh?.status === "comped") return true;
      tx.update(ref, {
        "billing.planId": plan.id,
        "billing.planName": plan.name,
        "billing.priceCents": priceCents,
        "billing.billingInterval": interval,
        "billing.currency": plan.currency,
        "billing.specialPriceCents": input.specialPriceCents,
        "billing.stripePriceId": stripePriceId,
        // Unchanged on Stripe; a NEW code on Paystack, which cancels one
        // subscription and opens another. Storing the stale one would make a
        // later cancel silently disable a dead subscription while the live one
        // kept charging the client.
        "billing.stripeSubscriptionId": subscriptionId,
        // The old code is superseded now; the stored-id check ignores it.
        ...(replaces
          ? { "billing.retiringSubscriptionId": null, "billing.retiringSince": null }
          : {}),
        "billing.updatedAt": FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return false;
    });
    if (comped) {
      // Paystack opened a new subscription for the switch: it must not keep charging a comped client.
      let stranded = false;
      if (subscriptionId !== billing.stripeSubscriptionId) {
        stranded = await provider.cancelSubscription(subscriptionId, billing.stripeCustomerId ?? null).then(
          () => false,
          (err) => {
            console.error(
              `[billing] plan switch on comped ${input.subAccountId}: new subscription ${subscriptionId} not cancelled`,
              err instanceof Error ? err.message : String(err),
            );
            return true;
          },
        );
      }
      if (replaces) await ref.update({ "billing.retiringSubscriptionId": null, "billing.retiringSince": null });
      recordBillingEvent({
        agencyId: input.agencyId,
        subAccountId: input.subAccountId,
        event: "plan.switch_abandoned",
        detail: { planId: plan.id, reason: "comped", newSubscription: subscriptionId, newSubscriptionCancelled: !stranded },
      });
      throw new BillingError(
        stranded
          ? `This client was comped while the plan change ran. The new subscription ${subscriptionId} couldn't be cancelled — cancel it in the provider's dashboard.`
          : "This client was comped while the plan change ran, so the plan change was undone. Nothing is billed.",
        409,
      );
    }
    await applyFeatureGates(input.subAccountId, plan.gates);

    recordBillingEvent({
      agencyId: input.agencyId,
      subAccountId: input.subAccountId,
      event: "plan.switched",
      detail: { planId: plan.id, planName: plan.name, priceCents },
    });
    runAfterResponse(() => emitWebhookEvent({
      subAccountId: input.subAccountId,
      agencyId: input.agencyId,
      mode: "live",
      type: "billing.plan.assigned",
      payload: {
        subAccountId: input.subAccountId,
        planId: plan.id,
        planName: plan.name,
        priceCents,
        currency: plan.currency,
        status: billing?.status ?? "active",
      },
    }));
    return { status: billing?.status ?? "active", checkoutUrl: null };
  }

  // Fresh assignment (or re-assignment after cancel): pending + link.
  const { token, hash } = issueCheckoutToken(input.subAccountId);
  const next: Record<string, unknown> = {
    billing: {
      status: "pending" satisfies SubAccountBillingStatus,
      planId: plan.id,
      planName: plan.name,
      priceCents,
      billingInterval: interval,
      currency: plan.currency,
      specialPriceCents: input.specialPriceCents,
      stripePriceId,
      stripeCustomerId: billing?.stripeCustomerId ?? null,
      stripeSubscriptionId: null,
      checkoutTokenHash: hash,
      graceUntil: null,
      assignedAt: FieldValue.serverTimestamp(),
      activatedAt: billing?.activatedAt ?? null,
      updatedAt: FieldValue.serverTimestamp(),
    },
    updatedAt: FieldValue.serverTimestamp(),
  };
  await ref.update(next);

  recordBillingEvent({
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    event: "plan.assigned",
    detail: {
      planId: plan.id,
      planName: plan.name,
      priceCents,
      specialPriceCents: input.specialPriceCents,
    },
  });
  runAfterResponse(() => emitWebhookEvent({
    subAccountId: input.subAccountId,
    agencyId: input.agencyId,
    mode: "live",
    type: "billing.plan.assigned",
    payload: {
      subAccountId: input.subAccountId,
      planId: plan.id,
      planName: plan.name,
      priceCents,
      currency: plan.currency,
      status: "pending",
    },
  }));

  return { status: "pending", checkoutUrl: buildCheckoutUrl(token) };
}

export { compSubAccount, type CompResult } from "@/lib/server/billing-comp";

/** Rotate the checkout token and return a fresh /pay URL. */
export async function mintCheckoutLink(input: {
  agencyId: string;
  subAccountId: string;
}): Promise<string> {
  const { ref, data } = await getSubInAgencyOrThrow(
    input.agencyId,
    input.subAccountId,
  );
  const billing = readBilling(data);
  if (!billing || billing.status === "comped" || !billing.planId) {
    throw new BillingError("Assign a plan before generating a checkout link.");
  }
  if (billing.status === "active") {
    throw new BillingError(
      "This client already has an active subscription — use the billing portal for card changes.",
    );
  }
  const { token, hash } = issueCheckoutToken(input.subAccountId);
  await ref.update({
    "billing.checkoutTokenHash": hash,
    "billing.updatedAt": FieldValue.serverTimestamp(),
  });
  return buildCheckoutUrl(token);
}

// ---------------------------------------------------------------------------
// Checkout session (used by /pay/[token] and the in-app activation screen)
// ---------------------------------------------------------------------------

export async function createSubAccountCheckoutSession(input: {
  subAccountId: string;
  /** Where Stripe returns the buyer. */
  successUrl: string;
  cancelUrl: string;
}): Promise<{ url: string }> {
  if (!billingStripeIsConfigured()) {
    throw new BillingError("Stripe isn't configured on this deployment.", 503);
  }
  const db = getAdminDb();
  const ref = db.doc(`subAccounts/${input.subAccountId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new BillingError("Sub-account not found", 404);
  const data = snap.data() as Record<string, unknown>;
  const billing = readBilling(data);

  if (!billing || !billing.planId || !billing.stripePriceId) {
    throw new BillingError("No plan is assigned to this workspace.", 409);
  }
  if (billing.status === "active") {
    throw new BillingError("This subscription is already active.", 409);
  }
  if (billing.status === "comped") {
    throw new BillingError("This workspace isn't billed through checkout.", 409);
  }

  const provider = getBillingProvider();
  const agencyId = String(data.agencyId ?? "");

  // One Stripe customer per sub-account, reused across re-checkouts so
  // payment history stays attached to the client.
  const contact = data.accountContact as {
    name?: string | null;
    email?: string | null;
  } | null;
  const { customerId, created } = await provider.ensureCustomer({
    existingCustomerId: billing.stripeCustomerId ?? null,
    name: String(data.name ?? "Sub-account"),
    email: contact?.email ?? null,
    metadata: {
      kind: SUB_ACCOUNT_PLAN_KIND,
      agencyId,
      subAccountId: input.subAccountId,
    },
  });
  if (created) {
    await ref.update({
      "billing.stripeCustomerId": customerId,
      "billing.updatedAt": FieldValue.serverTimestamp(),
    });
  }

  const { url } = await provider.createSubscriptionCheckout({
    customerId,
    priceId: billing.stripePriceId,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    metadata: {
      kind: SUB_ACCOUNT_PLAN_KIND,
      agencyId,
      subAccountId: input.subAccountId,
      planId: billing.planId,
    },
  });
  return { url };
}

// ---------------------------------------------------------------------------
// Stripe webhook handlers (called from lib/stripe/webhooks.ts routing)
// ---------------------------------------------------------------------------

/** checkout.session.completed with metadata.kind === "subAccountPlan". */






// ---------------------------------------------------------------------------
// One-time charges (agency → sub-account client, e.g. "Web design — $500")
// ---------------------------------------------------------------------------



function serializeCharge(
  id: string,
  data: FirebaseFirestore.DocumentData,
): BillingChargeResponse {
  return {
    id,
    subAccountId: String(data.subAccountId ?? ""),
    description: String(data.description ?? ""),
    amountCents: Number(data.amountCents ?? 0),
    currency: String(data.currency ?? "usd"),
    status:
      data.status === "paid" || data.status === "canceled"
        ? (data.status as BillingChargeStatus)
        : "pending",
    createdAt: tsToIso(data.createdAt),
    paidAt: tsToIso(data.paidAt),
    extraPaymentCount: Array.isArray(data.extraPaymentRefs) ? data.extraPaymentRefs.length : 0,
  };
}

export function validateChargeInput(
  description: unknown,
  amountCents: unknown,
  currency: unknown,
): { description: string; amountCents: number; currency: string } {
  const desc = typeof description === "string" ? description.trim() : "";
  if (!desc || desc.length > 120) {
    throw new BillingError("description is required (1–120 characters).");
  }
  if (
    typeof amountCents !== "number" ||
    !Number.isInteger(amountCents) ||
    amountCents < MIN_PRICE_CENTS ||
    amountCents > MAX_PRICE_CENTS
  ) {
    throw new BillingError(
      `amountCents must be an integer between ${MIN_PRICE_CENTS} and ${MAX_PRICE_CENTS}.`,
    );
  }
  const cur = typeof currency === "string" ? currency.trim().toLowerCase() : "";
  if (!/^[a-z]{3}$/.test(cur)) {
    throw new BillingError(
      'currency must be a 3-letter ISO code (e.g. "usd", "aud").',
    );
  }
  return { description: desc, amountCents, currency: cur };
}

/**
 * Create a one-time charge and mint its /pay/charge link. Works for ANY
 * sub-account in the agency — including comped ones (a one-off "web design"
 * fee doesn't require a subscription).
 */
export async function createOneTimeCharge(input: {
  agencyId: string;
  subAccountId: string;
  createdByUid: string;
  description: string;
  amountCents: number;
  currency: string;
}): Promise<{ charge: BillingChargeResponse; checkoutUrl: string }> {
  if (!billingStripeIsConfigured()) {
    throw new BillingError(
      "Stripe isn't configured on this deployment. Set STRIPE_SECRET_KEY first.",
      503,
    );
  }
  // Re-anchor the target to the caller's agency (same discipline as plans).
  await getSubInAgencyOrThrow(input.agencyId, input.subAccountId);

  const ref = chargesCollection().doc();
  const { token, hash } = issueChargeToken(ref.id);
  const doc: Omit<BillingChargeDoc, "id" | "createdAt" | "paidAt" | "updatedAt"> = {
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    description: input.description,
    amountCents: input.amountCents,
    currency: input.currency,
    status: "pending",
    tokenHash: hash,
    stripeCheckoutSessionId: null,
    stripePaymentIntentId: null,
    createdByUid: input.createdByUid,
  };
  await ref.set({
    ...doc,
    id: ref.id,
    createdAt: FieldValue.serverTimestamp(),
    paidAt: null,
    updatedAt: FieldValue.serverTimestamp(),
  });

  recordBillingEvent({
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    event: "charge.created",
    detail: {
      chargeId: ref.id,
      description: input.description,
      amountCents: input.amountCents,
      currency: input.currency,
    },
  });

  const snap = await ref.get();
  return {
    charge: serializeCharge(ref.id, snap.data() ?? {}),
    checkoutUrl: buildChargeCheckoutUrl(token),
  };
}

export async function listChargesForSubAccount(
  agencyId: string,
  subAccountId: string,
): Promise<BillingChargeResponse[]> {
  await getSubInAgencyOrThrow(agencyId, subAccountId);
  const snap = await chargesCollection()
    .where("subAccountId", "==", subAccountId)
    .limit(100)
    .get();
  return snap.docs
    .filter((d) => d.data().agencyId === agencyId)
    .map((d) => serializeCharge(d.id, d.data()))
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

async function getChargeInAgencyOrThrow(
  agencyId: string,
  chargeId: string,
): Promise<{ ref: FirebaseFirestore.DocumentReference; data: BillingChargeDoc }> {
  const ref = chargesCollection().doc(chargeId);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.agencyId !== agencyId) {
    throw new BillingError("Charge not found", 404);
  }
  return { ref, data: { ...(snap.data() as BillingChargeDoc), id: snap.id } };
}

/** Rotate the charge's token and return a fresh /pay/charge URL. */
export async function mintChargeCheckoutLink(input: {
  agencyId: string;
  chargeId: string;
}): Promise<string> {
  const { ref, data } = await getChargeInAgencyOrThrow(
    input.agencyId,
    input.chargeId,
  );
  if (data.status !== "pending") {
    throw new BillingError(
      data.status === "paid"
        ? "This charge is already paid."
        : "This charge was canceled — create a new one instead.",
    );
  }
  const { token, hash } = issueChargeToken(input.chargeId);
  await ref.update({
    tokenHash: hash,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return buildChargeCheckoutUrl(token);
}

/** Void a pending charge: kills the link; paid charges can't be canceled here. */
export async function cancelOneTimeCharge(input: {
  agencyId: string;
  chargeId: string;
}): Promise<void> {
  const { ref, data } = await getChargeInAgencyOrThrow(
    input.agencyId,
    input.chargeId,
  );
  if (data.status === "paid") {
    throw new BillingError(
      "This charge is already paid — refund it from the Stripe dashboard instead.",
    );
  }
  if (data.status === "canceled") return;
  await ref.update({
    status: "canceled" satisfies BillingChargeStatus,
    tokenHash: null,
    updatedAt: FieldValue.serverTimestamp(),
  });
  recordBillingEvent({
    agencyId: input.agencyId,
    subAccountId: data.subAccountId,
    event: "charge.canceled",
    detail: { chargeId: input.chargeId, description: data.description },
  });
}

/**
 * Start the Stripe Checkout for a verified /pay/charge token. mode:"payment"
 * with ad-hoc price_data — no Stripe Product/Price is created. Reuses the
 * sub-account's existing Stripe customer when one exists so the payment
 * lands on the same client record as their subscription.
 */
export async function createChargeCheckoutSession(input: {
  chargeId: string;
  successUrl: string;
  cancelUrl: string;
}): Promise<{ url: string }> {
  if (!billingStripeIsConfigured()) {
    throw new BillingError("Stripe isn't configured on this deployment.", 503);
  }
  const ref = chargesCollection().doc(input.chargeId);
  const snap = await ref.get();
  if (!snap.exists) throw new BillingError("Charge not found", 404);
  const charge = snap.data() as BillingChargeDoc;
  if (charge.status === "paid") {
    throw new BillingError("This charge is already paid — nothing more to do.");
  }
  if (charge.status === "canceled") {
    throw new BillingError(
      "This charge was canceled. Ask your provider for a new payment link.",
    );
  }

  const subSnap = await getAdminDb()
    .doc(`subAccounts/${charge.subAccountId}`)
    .get();
  const billing = subSnap.exists
    ? readBilling(subSnap.data() as Record<string, unknown>)
    : null;

  const contact = subSnap.exists
    ? ((subSnap.data() as Record<string, unknown>).accountContact as {
        email?: string | null;
      } | null)
    : null;

  const { url, sessionId } = await getBillingProvider().createOneTimeCheckout({
    customerId: billing?.stripeCustomerId ?? null,
    // Only used by a provider that can't open a guest checkout (Paystack).
    payerEmail: contact?.email ?? null,
    currency: charge.currency,
    amountCents: charge.amountCents,
    productName: charge.description,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    metadata: {
      kind: SUB_ACCOUNT_CHARGE_KIND,
      agencyId: charge.agencyId,
      subAccountId: charge.subAccountId,
      chargeId: input.chargeId,
    },
  });
  await ref.update({
    stripeCheckoutSessionId: sessionId,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { url };
}

/** checkout.session.completed with metadata.kind === "subAccountCharge". */

/**
 * The lifecycle half, re-exported so callers that have always imported these
 * from `billing-service` keep working. New code should import them from
 * `billing-lifecycle` directly.
 */
export {
  activateSubAccountPlan,
  applySubAccountSubscriptionStatus,
  handleSubAccountChargeCheckoutCompleted,
  handleSubAccountPlanCheckoutCompleted,
  handleSubAccountSubscriptionEvent,
  markSubAccountChargePaid,
  normalizePlanGates,
  recordSubAccountSubscriptionId,
} from "@/lib/server/billing-lifecycle";
