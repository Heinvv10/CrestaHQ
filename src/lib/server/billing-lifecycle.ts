import "server-only";

import type Stripe from "stripe";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { applyFeatureGates } from "@/lib/server/feature-gates-service";
import { billingEventFlagId, subscriptionFlagReason } from "@/lib/server/billing-attention";
import { notifyFlag } from "@/lib/server/billing-attention-notify";
import { emitWebhookEvent } from "@/lib/api/webhooks/dispatch";
import {
  activationLedgerRef,
  flagBillingPayment,
  type BillingPaymentProvider,
} from "@/lib/server/billing-payment-ledger";
import {
  BILLING_GRACE_DAYS,
  PLAN_GATE_KEYS,
  type BillingChargeDoc,
  type BillingChargeStatus,
  type PlanGates,
  type SubAccountBilling,
  type SubAccountBillingStatus,
} from "@/types/billing";
import { runAfterResponse } from "@/lib/server/after-response";

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
    | "plan.switch_abandoned"
    | "comped"
    | "activated"
    | "status.changed"
    | "charge.created"
    | "charge.paid"
    | "charge.canceled";
  detail: Record<string, unknown>;
}): void {
  runAfterResponse(() => getAdminDb()
    .collection("billingEvents")
    .add({
      ...entry,
      createdAt: FieldValue.serverTimestamp(),
    })
    .catch((err) =>
      console.warn("[billing] failed to record billing event", err),
    ));
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
 * An activation is tied to the payment that made it (`reference`: Stripe's
 * checkout session, Paystack's transaction). Providers redeliver for days, so:
 *   - a reference that already activated is a replay and changes nothing —
 *     not after a cancellation, not after a re-assignment of the same plan;
 *   - a NEW payment for a workspace that is comped, on another plan, or
 *     already active is real money that activates nothing: it is flagged
 *     for the agency to refund, not applied.
 * The ledger row and the activation commit together, so a crash between
 * them cannot leave a paid workspace walled or a replay unrecognised.
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
  provider: BillingPaymentProvider;
  reference: string;
  /** For a flag row: what the provider says was paid. */
  amountCents: number | null;
  currency: string | null;
}): Promise<void> {
  const { subAccountId, planId } = input;

  const db = getAdminDb();
  const ref = db.doc(`subAccounts/${subAccountId}`);
  const ledgerRef = activationLedgerRef(input.provider, input.reference);

  const outcome = await db.runTransaction(async (tx) => {
    const [ledger, snap] = [await tx.get(ledgerRef), await tx.get(ref)];
    if (ledger.exists) return { kind: "replay" as const };
    if (!snap.exists) return { kind: "missing" as const };
    const data = snap.data() as Record<string, unknown>;
    const billing = readBilling(data);
    const agencyId = String(data.agencyId ?? "");

    // Activated before the ledger existed: the stored reference / subscription
    // is the only record that this payment was already spent.
    if (
      billing?.paystackReference === input.reference ||
      (billing?.status === "active" &&
        !!input.subscriptionId &&
        billing.stripeSubscriptionId === input.subscriptionId)
    ) {
      return { kind: "replay" as const };
    }

    const reason =
      !billing || billing.status === "comped"
        ? "workspace is comped"
        : billing.planId !== planId
          ? `plan=${planId} assigned=${billing.planId ?? null}`
          : billing.status === "active"
            ? "plan already active — paid twice"
            : null;
    if (reason) return { kind: "flag" as const, reason, agencyId };

    tx.create(ledgerRef, {
      agencyId,
      subAccountId,
      planId,
      provider: input.provider,
      reference: input.reference,
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.update(ref, {
      "billing.status": "active" satisfies SubAccountBillingStatus,
      "billing.stripeCustomerId":
        input.customerId ?? billing!.stripeCustomerId ?? null,
      "billing.stripeSubscriptionId":
        input.subscriptionId ?? billing!.stripeSubscriptionId ?? null,
      "billing.checkoutTokenHash": null,
      "billing.graceUntil": null,
      "billing.activatedAt": FieldValue.serverTimestamp(),
      "billing.updatedAt": FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { kind: "activated" as const, agencyId, billing: billing! };
  });

  if (outcome.kind === "missing") {
    console.error(`[billing] checkout completed for missing sub-account ${subAccountId}`);
    return;
  }
  if (outcome.kind === "replay") return;
  if (outcome.kind === "flag") {
    await flagBillingPayment({
      provider: input.provider,
      reference: input.reference,
      agencyId: outcome.agencyId,
      subAccountId,
      kind: "plan",
      reason: outcome.reason,
      amountCents: input.amountCents,
      currency: input.currency,
    });
    return;
  }
  const { agencyId, billing } = outcome;

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
      planName: billing.planName ?? null,
      priceCents: billing.priceCents ?? null,
      stripeSubscriptionId: input.subscriptionId,
      provider: input.provider,
      reference: input.reference,
    },
  });
  runAfterResponse(() => emitWebhookEvent({
    subAccountId,
    agencyId,
    mode: "live",
    type: "billing.activated",
    payload: {
      subAccountId,
      planId,
      planName: billing.planName ?? null,
      priceCents: billing.priceCents ?? null,
      currency: billing.currency ?? null,
    },
  }));
}

/** Stripe's `checkout.session.completed` for a sub-account plan. */
export async function handleSubAccountPlanCheckoutCompleted(
  session: Stripe.Checkout.Session,
): Promise<void> {
  const subAccountId = session.metadata?.subAccountId;
  const planId = session.metadata?.planId;
  // A delayed payment method (SEPA, ACH, …) completes the session unpaid; the
  // money lands later with `checkout.session.async_payment_succeeded`, which
  // comes back through here paid.
  if (session.payment_status === "unpaid") {
    console.warn(`[billing] plan checkout ${session.id} completed unpaid — waiting for the payment`);
    return;
  }
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
    provider: "stripe",
    reference: session.id,
    amountCents: session.amount_total ?? null,
    currency: session.currency ?? null,
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
  //
  // A cancelled or pending workspace with NO stored subscription has none of
  // its own: a named event is for one that already ended (a late `.updated`
  // behind its `.deleted`) or one whose payment has not landed. Neither may
  // move it — activation comes only from the payment, and a deleted
  // subscription is never revived by the provider.
  if (
    subscriptionId &&
    billing.stripeSubscriptionId !== subscriptionId &&
    (billing.stripeSubscriptionId ||
      billing.status === "canceled" ||
      billing.status === "pending")
  ) {
    return;
  }
  // Mid plan switch: the subscription being replaced is disabled before the
  // new code is stored, and its disable webhook can land in that gap.
  if (subscriptionId && isRetiring(billing, subscriptionId)) {
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
      runAfterResponse(() => emitWebhookEvent({
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
      }));
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
 *
 * Paystack's `subscription.create` names only the customer and the plan, and
 * one Paystack customer can back several workspaces (Paystack keys customers
 * on email, and two workspaces can share an account contact). So the customer
 * alone decides nothing when it is shared: the workspace must also be on the
 * event's plan and, if several are, be the one waiting for a subscription (no
 * code stored, not cancelled). If that still leaves more than one, nothing is
 * written and the event is flagged — storing it on the wrong one would point that
 * workspace's cancel at another client's subscription.
 */
export async function recordSubAccountSubscriptionId(input: {
  customerId: string;
  subscriptionId: string;
  /** The plan the new subscription is on, when the event names it. */
  planCode?: string | null;
}): Promise<void> {
  const db = getAdminDb();
  // Already stored (the plan switch writes its own code): nothing to decide.
  if (await findSubAccountByBillingField("billing.stripeSubscriptionId", input.subscriptionId)) {
    return;
  }
  const byCustomer = await db
    .collection("subAccounts")
    .where("billing.stripeCustomerId", "==", input.customerId)
    .get();
  const billed = byCustomer.docs.filter((d) => {
    const billing = readBilling(d.data());
    // A comped workspace is not billed at all.
    return !!billing && billing.status !== "comped";
  });
  let candidates =
    billed.length > 1 && input.planCode
      ? billed.filter((d) => readBilling(d.data())?.stripePriceId === input.planCode)
      : billed;
  if (candidates.length > 1) {
    // Still shared: the new subscription belongs to a workspace waiting for
    // one — not a cancelled one, and not one already on its own.
    const waiting = candidates.filter((d) => {
      const b = readBilling(d.data());
      return !b?.stripeSubscriptionId && b?.status !== "canceled";
    });
    if (waiting.length > 0) candidates = waiting;
  }
  if (candidates.length !== 1) {
    console.error(
      `[billing] subscription ${input.subscriptionId} for customer ${input.customerId} matches ${candidates.length} workspaces — not stored`,
    );
    if (billed.length > 1) {
      const eventId = `subscription-flag-${encodeURIComponent(input.subscriptionId)}`;
      const agencyId = String(billed[0].data().agencyId ?? "");
      await db
        .collection("billingEvents")
        .doc(eventId)
        .set({
          agencyId,
          subAccountId: null,
          event: "subscription.flagged",
          detail: {
            subscriptionId: input.subscriptionId,
            customerId: input.customerId,
            planCode: input.planCode ?? null,
            candidates: (candidates.length > 0 ? candidates : billed).map((d) => d.id),
          },
          createdAt: FieldValue.serverTimestamp(),
        });
      const flaggedIds = (candidates.length > 0 ? candidates : billed).map((d) => d.id);
      await notifyFlag({
        flagId: billingEventFlagId(eventId),
        audience: "agencyOwner",
        agencyId,
        subAccountId: null,
        candidates: flaggedIds,
        reason: subscriptionFlagReason(flaggedIds.length),
        amountCents: null,
        currency: null,
        reference: input.subscriptionId,
      });
    }
    return;
  }
  const ref = candidates[0].ref;
  await ref.update({
    "billing.stripeSubscriptionId": input.subscriptionId,
    "billing.updatedAt": FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
}

/** How long a plan switch's mark on the subscription it replaces is honoured. */
const RETIRING_TTL_MS = 10 * 60 * 1000;

/**
 * Whether `subscriptionId` is the one a plan switch is replacing right now —
 * also the switch's lock (see `assignPlanToSubAccount`). Bounded in time so a
 * switch that crashed before clearing its mark cannot mute that
 * subscription's events, or block the next switch, forever.
 */
export function isRetiring(billing: SubAccountBilling, subscriptionId: string): boolean {
  const since = billing.retiringSince as { toMillis?: () => number } | Date | null | undefined;
  const sinceMs =
    since instanceof Date ? since.getTime() : typeof since?.toMillis === "function" ? since.toMillis() : null;
  return (
    billing.retiringSubscriptionId === subscriptionId &&
    sinceMs !== null &&
    Date.now() - sinceMs < RETIRING_TTL_MS
  );
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
  // Unpaid = a delayed payment method still settling (see the plan handler).
  if (session.payment_status === "unpaid") {
    console.warn(`[billing] charge checkout ${session.id} completed unpaid — waiting for the payment`);
    return;
  }
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

  // Compare-and-set: two deliveries (a redelivery, or the link paid from two
  // tabs) can race, and only the one whose write commits may emit charge.paid.
  const charge = await getAdminDb().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) {
      console.error(`[billing] checkout completed for missing charge ${chargeId}`);
      return null;
    }
    const current = snap.data() as BillingChargeDoc;
    if (current.status === "paid") {
      // A redelivery carries the checkout that paid it — idempotent. A
      // DIFFERENT checkout is a second payment: record it so the agency sees
      // it and can refund, rather than dropping real money.
      if (
        input.checkoutSessionId &&
        current.stripeCheckoutSessionId &&
        input.checkoutSessionId !== current.stripeCheckoutSessionId
      ) {
        console.warn(
          `[billing] charge ${chargeId} paid again by ${input.checkoutSessionId} — a refund is owed`,
        );
        tx.update(ref, {
          extraPaymentRefs: FieldValue.arrayUnion(input.checkoutSessionId),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      return null;
    }
    tx.update(ref, {
      status: "paid" satisfies BillingChargeStatus,
      tokenHash: null,
      stripeCheckoutSessionId: input.checkoutSessionId,
      stripePaymentIntentId: input.paymentId,
      paidAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return current;
  });
  if (!charge) return;

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
  runAfterResponse(() => emitWebhookEvent({
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
  }));
}
