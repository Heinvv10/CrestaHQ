import "server-only";

import type Stripe from "stripe";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { applyFeatureGates } from "@/lib/server/feature-gates-service";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import {
  BILLING_GRACE_DAYS,
  PLAN_GATE_KEYS,
  type BillingChargeDoc,
  type BillingChargeStatus,
  type PlanGates,
  type SubAccountBilling,
  type SubAccountBillingStatus,
} from "@/types/billing";

/**
 * Client Billing's LIFECYCLE — the state changes a payment provider drives:
 * a plan activating, a subscription's status moving, a one-time charge being
 * paid, and the audit trail behind all three.
 *
 * Provider-neutral on purpose. Stripe and Paystack both land here, so
 * activation, the gate bundle, the dunning grace window, the `billingEvents`
 * row and the outbound webhook cannot drift between the two rails; the
 * per-provider handlers below are thin adapters that map each provider's own
 * vocabulary onto these.
 *
 * Split out of `billing-service.ts`, which owns the operator-driven half
 * (creating plans, assigning them, minting checkout links). The two halves
 * have different callers — webhooks here, API routes there — and the file was
 * far past the 300-line cap with both in it.
 */

/**
 * Append-only billing audit trail (top-level `billingEvents`, mirroring the
 * aiSuiteActions pattern): one row per assignment, comp, activation, and
 * dunning transition, so "who put this client on what, when" is answerable
 * without spelunking Stripe. Best-effort — never blocks the primary write.
 */
export function recordBillingEvent(entry: {
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

/** Normalize an untrusted gates payload into a full PlanGates record. */
export function normalizePlanGates(input: unknown): PlanGates {
  const source = (input ?? {}) as Record<string, unknown>;
  const gates = {} as PlanGates;
  for (const key of PLAN_GATE_KEYS) {
    gates[key] = source[key] === true;
  }
  return gates;
}

export function readBilling(
  data: Record<string, unknown>,
): SubAccountBilling | null {
  return (data.billing as SubAccountBilling | null | undefined) ?? null;
}

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

  // A provider can redeliver a payment event days later — and this endpoint
  // deliberately 500s on failure to force retries, so redelivery is routine.
  // If the workspace is already active on a DIFFERENT plan, this event is
  // stale: re-applying its gate bundle would silently restore the old plan's
  // features onto the plan the client actually has now.
  if (
    billing?.status === "active" &&
    billing.planId &&
    billing.planId !== planId
  ) {
    console.warn(
      `[billing] ignoring a stale activation for plan ${planId}; ${subAccountId} is active on ${billing.planId}`,
    );
    return;
  }

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
  /**
   * Evidence that this event is about the subscription we are tracking, not
   * merely about the same customer. When set, it must equal the workspace's
   * stored price id or nothing is written.
   *
   * A provider's payment feed carries EVERY charge on the account. Matching a
   * workspace by customer alone would let an unrelated payment by the same
   * person — a different product, a dashboard test charge — clear their
   * dunning window and unlock a workspace whose plan is still unpaid.
   */
  matchPriceId?: string | null;
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
  if (input.matchPriceId && billing.stripePriceId !== input.matchPriceId) {
    return;
  }
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

/**
 * Record which subscription a workspace is on, and nothing else.
 *
 * Deliberately NOT a status change: the provider may tell us the subscription
 * exists before it tells us the payment succeeded, and activating on that
 * would unlock the workspace at whatever gates it held while pending, fire a
 * duplicate `billing.activated`, and leave its checkout link live. Activation
 * has exactly one source — the payment event, via `activateSubAccountPlan`.
 */
export async function recordSubAccountSubscriptionId(input: {
  customerId: string;
  subscriptionId: string;
}): Promise<void> {
  const subAccountId = await findSubAccountByBillingField(
    "billing.stripeCustomerId",
    input.customerId,
  );
  if (!subAccountId) {
    console.error(
      `[billing] no sub-account for customer ${input.customerId} on subscription ${input.subscriptionId}`,
    );
    return;
  }
  const ref = getAdminDb().doc(`subAccounts/${subAccountId}`);
  const snap = await ref.get();
  if (!snap.exists) return;
  const billing = readBilling(snap.data() as Record<string, unknown>);
  // A comped workspace is not billed at all, and one already pointing at this
  // subscription needs no write.
  if (!billing || billing.status === "comped") return;
  if (billing.stripeSubscriptionId === input.subscriptionId) return;

  await ref.update({
    "billing.stripeSubscriptionId": input.subscriptionId,
    "billing.updatedAt": FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
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

export function chargesCollection() {
  return getAdminDb().collection("billingCharges");
}

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

  // The agency cancelled this charge, but the payer completed an already-open
  // payment page. The money is real, so it is recorded rather than dropped —
  // loudly, because the agency believes this charge is void and needs to know
  // to refund it.
  const wasCanceled = charge.status === "canceled";
  if (wasCanceled) {
    console.warn(
      `[billing] charge ${chargeId} was canceled but has been paid — refund it or reinstate it`,
    );
  }

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
      ...(wasCanceled ? { paidAfterCancel: true } : {}),
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
