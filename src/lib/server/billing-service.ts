import "server-only";

import type Stripe from "stripe";
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
  BILLING_GRACE_DAYS,
  PLAN_GATE_KEYS,
  type BillingChargeDoc,
  type BillingChargeResponse,
  type BillingChargeStatus,
  type BillingInterval,
  type BillingPlanDoc,
  type BillingPlanResponse,
  type PlanGates,
  type SubAccountBilling,
  type SubAccountBillingStatus,
} from "@/types/billing";
import { BillingError } from "@/lib/billing/errors";
import {
  SUB_ACCOUNT_CHARGE_KIND,
  SUB_ACCOUNT_PLAN_KIND,
} from "@/lib/billing/kinds";

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

/**
 * Append-only billing audit trail (top-level `billingEvents`, mirroring the
 * aiSuiteActions pattern): one row per assignment, comp, activation, and
 * dunning transition, so "who put this client on what, when" is answerable
 * without spelunking Stripe. Best-effort — never blocks the primary write.
 */
function recordBillingEvent(entry: {
  agencyId: string;
  subAccountId: string;
  event:
    | "plan.assigned"
    | "plan.switched"
    | "comped"
    | "activated"
    | "status.changed"
    | "charge.created"
    | "charge.paid"
    | "charge.canceled";
  detail: Record<string, unknown>;
}): void {
  getAdminDb()
    .collection("billingEvents")
    .add({
      ...entry,
      createdAt: FieldValue.serverTimestamp(),
    })
    .catch((err) =>
      console.warn("[billing] failed to record billing event", err),
    );
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

/** Normalize an untrusted gates payload into a full PlanGates record. */
export function normalizePlanGates(input: unknown): PlanGates {
  const source = (input ?? {}) as Record<string, unknown>;
  const gates = {} as PlanGates;
  for (const key of PLAN_GATE_KEYS) {
    gates[key] = source[key] === true;
  }
  return gates;
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

function readBilling(
  data: Record<string, unknown>,
): SubAccountBilling | null {
  return (data.billing as SubAccountBilling | null | undefined) ?? null;
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
}): Promise<AssignPlanResult> {
  if (!billingStripeIsConfigured()) {
    throw new BillingError(
      "Stripe isn't configured on this deployment. Set STRIPE_SECRET_KEY first.",
      503,
    );
  }
  const interval: BillingInterval = input.interval === "year" ? "year" : "month";
  const plan = await getPlanOrThrow(input.agencyId, input.planId);
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
    const { subscriptionId } = await provider.switchSubscriptionPlan({
      subscriptionId: billing.stripeSubscriptionId as string,
      priceId: stripePriceId,
      timing: provider.planSwitchTiming,
      metadata: {
        kind: SUB_ACCOUNT_PLAN_KIND,
        agencyId: input.agencyId,
        subAccountId: input.subAccountId,
        planId: plan.id,
      },
    });

    await ref.update({
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
      "billing.updatedAt": FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    await applyFeatureGates(input.subAccountId, plan.gates);

    recordBillingEvent({
      agencyId: input.agencyId,
      subAccountId: input.subAccountId,
      event: "plan.switched",
      detail: { planId: plan.id, planName: plan.name, priceCents },
    });
    void emitWebhookEvent({
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
    });
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
  void emitWebhookEvent({
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
  });

  return { status: "pending", checkoutUrl: buildCheckoutUrl(token) };
}

/**
 * Mark a sub-account comped: cancel any live Stripe subscription
 * immediately and return gate control to manual. Data + gates untouched.
 */
export async function compSubAccount(input: {
  agencyId: string;
  subAccountId: string;
}): Promise<void> {
  const { ref, data } = await getSubInAgencyOrThrow(
    input.agencyId,
    input.subAccountId,
  );
  const billing = readBilling(data);

  if (billing?.stripeSubscriptionId && billingStripeIsConfigured()) {
    await getBillingProvider()
      .cancelSubscription(billing.stripeSubscriptionId)
      .catch((err) => {
        // Already-canceled/missing subscriptions shouldn't block the comp.
        console.warn("[billing] cancel-on-comp failed (continuing)", err);
      });
  }

  await ref.update({
    billing: {
      status: "comped" satisfies SubAccountBillingStatus,
      planId: null,
      planName: null,
      priceCents: null,
      billingInterval: null,
      currency: null,
      specialPriceCents: null,
      stripePriceId: null,
      stripeCustomerId: billing?.stripeCustomerId ?? null,
      stripeSubscriptionId: null,
      checkoutTokenHash: null,
      graceUntil: null,
      assignedAt: billing?.assignedAt ?? null,
      activatedAt: billing?.activatedAt ?? null,
      updatedAt: FieldValue.serverTimestamp(),
    },
    updatedAt: FieldValue.serverTimestamp(),
  });

  recordBillingEvent({
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    event: "comped",
    detail: {
      previousStatus: billing?.status ?? null,
      canceledSubscription: billing?.stripeSubscriptionId ?? null,
    },
  });
}

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
/**
 * A client's plan payment landed. Provider-neutral: Stripe and Paystack both
 * arrive here, so activation, the gate bundle, the audit row and the outbound
 * webhook cannot drift between the two rails.
 *
 * `subscriptionId` is null when the provider has not told us the subscription
 * yet — Paystack sends the payment and the subscription as separate events, in
 * no guaranteed order, so it is filled in by whichever arrives second.
 */
export async function activateSubAccountPlan(input: {
  subAccountId: string;
  planId: string;
  customerId: string | null;
  subscriptionId: string | null;
}): Promise<void> {
  const { subAccountId, planId } = input;

  const db = getAdminDb();
  const ref = db.doc(`subAccounts/${subAccountId}`);
  const snap = await ref.get();
  if (!snap.exists) {
    console.error(`[billing] checkout completed for missing sub-account ${subAccountId}`);
    return;
  }
  const data = snap.data() as Record<string, unknown>;
  const agencyId = String(data.agencyId ?? "");
  const billing = readBilling(data);

  await ref.update({
    "billing.status": "active" satisfies SubAccountBillingStatus,
    "billing.stripeCustomerId":
      input.customerId ?? billing?.stripeCustomerId ?? null,
    "billing.stripeSubscriptionId":
      input.subscriptionId ?? billing?.stripeSubscriptionId ?? null,
    "billing.checkoutTokenHash": null,
    "billing.graceUntil": null,
    "billing.activatedAt": FieldValue.serverTimestamp(),
    "billing.updatedAt": FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  // Apply the plan's gate bundle now that payment landed. Look the plan up
  // fresh so a gate edit between assignment and payment still applies.
  try {
    const planSnap = await db
      .doc(`agencies/${agencyId}/plans/${planId}`)
      .get();
    const gates = planSnap.exists
      ? normalizePlanGates(planSnap.data()?.gates)
      : null;
    if (gates) {
      const { skippedMetaGates } = await applyFeatureGates(subAccountId, gates);
      if (skippedMetaGates.length > 0) {
        console.warn(
          `[billing] plan ${planId} wants Meta gates but the deployment lacks META_APP_ID/SECRET — left off for ${subAccountId}`,
        );
      }
    }
  } catch (err) {
    // Activation must not fail because a gate write blipped — the agency
    // can re-apply from the Manage dialog.
    console.error("[billing] gate application on activation failed", err);
  }

  recordBillingEvent({
    agencyId,
    subAccountId,
    event: "activated",
    detail: {
      planId,
      planName: billing?.planName ?? null,
      priceCents: billing?.priceCents ?? null,
      stripeSubscriptionId: input.subscriptionId,
    },
  });
  void emitWebhookEvent({
    subAccountId,
    agencyId,
    mode: "live",
    type: "billing.activated",
    payload: {
      subAccountId,
      planId,
      planName: billing?.planName ?? null,
      priceCents: billing?.priceCents ?? null,
      currency: billing?.currency ?? null,
    },
  });
}

/** Stripe's `checkout.session.completed` for a sub-account plan. */
export async function handleSubAccountPlanCheckoutCompleted(
  session: Stripe.Checkout.Session,
): Promise<void> {
  const subAccountId = session.metadata?.subAccountId;
  const planId = session.metadata?.planId;
  if (!subAccountId || !planId) {
    console.error(
      "[billing] subAccountPlan checkout completed without subAccountId/planId metadata",
    );
    return;
  }
  await activateSubAccountPlan({
    subAccountId,
    planId,
    customerId: (session.customer as string | null) ?? null,
    subscriptionId: (session.subscription as string | null) ?? null,
  });
}

/**
 * A subscription's status changed at the provider. Provider-neutral: the
 * caller maps its own status vocabulary onto ours, and everything that follows
 * — the superseded-subscription guard, the pending guard, the once-per-episode
 * grace stamp, the audit row and the outbound event — is shared.
 */
export async function applySubAccountSubscriptionStatus(input: {
  /**
   * The provider's subscription id, or null when the event does not name one
   * — a Paystack renewal names only the customer. Null means "leave the stored
   * id alone": writing anything else there would repoint the workspace at a
   * subscription that is not its own.
   */
  subscriptionId: string | null;
  /**
   * The provider's own status, already mapped onto ours. `null` means the
   * provider said something we do not map — leave the client's status alone
   * rather than guessing, which is what an unmapped status must never change.
   */
  status: SubAccountBillingStatus | null;
  /** The subscription is gone; clear the stored id. */
  deleted: boolean;
  /** Known from the event's metadata, when the provider carries any. */
  subAccountIdHint?: string | null;
  /** Fallback identity when the provider names only the customer. */
  customerIdHint?: string | null;
  /** For the audit row: what the provider actually called this status. */
  providerStatus?: string;
}): Promise<void> {
  const db = getAdminDb();
  const subscriptionId = input.subscriptionId;

  // Fast path: the event named the sub-account. Otherwise look it up by the
  // subscription, then by the customer — Paystack's renewal events name only
  // the customer, and Stripe subscriptions can have their metadata stripped in
  // the dashboard.
  let subAccountId: string | null = input.subAccountIdHint ?? null;
  if (!subAccountId && subscriptionId) {
    subAccountId = await findSubAccountByBillingField(
      "billing.stripeSubscriptionId",
      subscriptionId,
    );
  }
  if (!subAccountId && input.customerIdHint) {
    subAccountId = await findSubAccountByBillingField(
      "billing.stripeCustomerId",
      input.customerIdHint,
    );
  }
  if (!subAccountId) {
    console.error(
      `[billing] no sub-account found for subscription ${subscriptionId ?? "(unnamed)"}`,
    );
    return;
  }

  const ref = db.doc(`subAccounts/${subAccountId}`);
  const snap = await ref.get();
  if (!snap.exists) return;
  const data = snap.data() as Record<string, unknown>;
  const agencyId = String(data.agencyId ?? "");
  const billing = readBilling(data);
  if (!billing || billing.status === "comped") return;
  // Ignore events from a superseded subscription (e.g. the old sub's
  // cancellation arriving after a re-checkout already created a new one).
  // Only checkable when the event named a subscription. An unnamed event was
  // matched by customer, and the workspace has exactly one billing record, so
  // there is no second subscription for it to be confused with.
  if (
    subscriptionId &&
    billing.stripeSubscriptionId &&
    billing.stripeSubscriptionId !== subscriptionId
  ) {
    return;
  }

  // While pending (client hasn't completed checkout), only a transition to
  // "active" is meaningful — half-finished checkout sessions emit
  // incomplete/incomplete_expired subscription noise that must not flip a
  // never-paid workspace into dunning or cancellation.
  if (billing.status === "pending" && input.status !== "active") {
    return;
  }

  const nextStatus: SubAccountBillingStatus = input.deleted
    ? "canceled"
    : (input.status ?? billing.status);

  const updates: Record<string, unknown> = {
    "billing.updatedAt": FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (input.deleted) {
    updates["billing.stripeSubscriptionId"] = null;
  } else if (subscriptionId) {
    updates["billing.stripeSubscriptionId"] = subscriptionId;
  }

  if (nextStatus !== billing.status) {
    updates["billing.status"] = nextStatus;
  }
  if (nextStatus === "past_due") {
    // Stamp the grace window ONCE per dunning episode — repeat past_due
    // events (Stripe retries) must not keep pushing the paywall out.
    const alreadyStamped = billing.status === "past_due" && billing.graceUntil;
    if (!alreadyStamped) {
      updates["billing.graceUntil"] = Timestamp.fromMillis(
        Date.now() + BILLING_GRACE_DAYS * 24 * 60 * 60 * 1000,
      );
    }
  }
  if (nextStatus === "active") {
    updates["billing.graceUntil"] = null;
  }

  await ref.update(updates);

  if (nextStatus !== billing.status) {
    recordBillingEvent({
      agencyId,
      subAccountId,
      event: "status.changed",
      detail: {
        previousStatus: billing.status,
        status: nextStatus,
        stripeStatus: input.providerStatus ?? nextStatus,
        deleted: input.deleted,
      },
    });
    const eventType =
      nextStatus === "past_due"
        ? "billing.past_due"
        : nextStatus === "canceled"
          ? "billing.canceled"
          : nextStatus === "active"
            ? "billing.activated"
            : null;
    if (eventType) {
      void emitWebhookEvent({
        subAccountId,
        agencyId,
        mode: "live",
        type: eventType,
        payload: {
          subAccountId,
          planId: billing.planId,
          planName: billing.planName,
          previousStatus: billing.status,
          status: nextStatus,
        },
      });
    }
  }
}

/** Single-field equality query — no composite index, no collection group. */
async function findSubAccountByBillingField(
  field: string,
  value: string,
): Promise<string | null> {
  const match = await getAdminDb()
    .collection("subAccounts")
    .where(field, "==", value)
    .limit(1)
    .get();
  return match.empty ? null : match.docs[0].id;
}

/**
 * Stripe's `customer.subscription.updated` / `.deleted`. Maps Stripe's status
 * vocabulary onto ours, then hands off to the shared handler.
 */
export async function handleSubAccountSubscriptionEvent(
  subscription: Stripe.Subscription,
  opts: { deleted: boolean },
): Promise<void> {
  let status: SubAccountBillingStatus | null;
  switch (subscription.status) {
    case "active":
    case "trialing":
      status = "active";
      break;
    case "past_due":
    case "unpaid":
    case "incomplete":
      status = "past_due";
      break;
    case "canceled":
    case "incomplete_expired":
      status = "canceled";
      break;
    default:
      // Anything Stripe adds later must not silently move a client's status.
      status = null;
  }
  await applySubAccountSubscriptionStatus({
    subscriptionId: subscription.id,
    status,
    deleted: opts.deleted,
    subAccountIdHint: subscription.metadata?.subAccountId ?? null,
    providerStatus: subscription.status,
  });
}

// ---------------------------------------------------------------------------
// One-time charges (agency → sub-account client, e.g. "Web design — $500")
// ---------------------------------------------------------------------------

/** Stripe's `checkout.session.completed` for a one-time charge. */
export async function handleSubAccountChargeCheckoutCompleted(
  session: Stripe.Checkout.Session,
): Promise<void> {
  const chargeId = session.metadata?.chargeId;
  if (!chargeId) {
    console.error(
      "[billing] subAccountCharge checkout completed without chargeId metadata",
    );
    return;
  }
  await markSubAccountChargePaid({
    chargeId,
    checkoutSessionId: session.id,
    paymentId:
      typeof session.payment_intent === "string" ? session.payment_intent : null,
  });
}

function chargesCollection() {
  return getAdminDb().collection("billingCharges");
}

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
 * A one-time charge was paid. Provider-neutral; idempotent on the charge's own
 * status, so a provider retrying the same event marks nothing twice.
 */
export async function markSubAccountChargePaid(input: {
  chargeId: string;
  /** The provider's checkout/transaction reference. */
  checkoutSessionId: string | null;
  /** The provider's payment id, when it has one distinct from the session. */
  paymentId: string | null;
}): Promise<void> {
  const { chargeId } = input;
  const ref = chargesCollection().doc(chargeId);
  const snap = await ref.get();
  if (!snap.exists) {
    console.error(`[billing] checkout completed for missing charge ${chargeId}`);
    return;
  }
  const charge = snap.data() as BillingChargeDoc;
  if (charge.status === "paid") return; // webhook retry — idempotent

  await ref.update({
    status: "paid" satisfies BillingChargeStatus,
    tokenHash: null,
    stripeCheckoutSessionId: input.checkoutSessionId,
    stripePaymentIntentId: input.paymentId,
    paidAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  recordBillingEvent({
    agencyId: charge.agencyId,
    subAccountId: charge.subAccountId,
    event: "charge.paid",
    detail: {
      chargeId,
      description: charge.description,
      amountCents: charge.amountCents,
      currency: charge.currency,
    },
  });
  void emitWebhookEvent({
    subAccountId: charge.subAccountId,
    agencyId: charge.agencyId,
    mode: "live",
    type: "billing.charge.paid",
    payload: {
      chargeId,
      subAccountId: charge.subAccountId,
      description: charge.description,
      amountCents: charge.amountCents,
      currency: charge.currency,
    },
  });
}
