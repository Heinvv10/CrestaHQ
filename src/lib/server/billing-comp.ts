import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getBillingProvider } from "@/lib/billing/provider";
import { BillingError, SubscriptionNotOnAccount } from "@/lib/billing/errors";
import { isRetiring, readBilling, recordBillingEvent, retiringSinceMs } from "@/lib/server/billing-lifecycle";
import type { SubAccountBilling, SubAccountBillingStatus } from "@/types/billing";

/**
 * Comping a sub-account (Manage dialog + the assistant's comp_client):
 * cancel any live subscription on the payment provider, then mark the
 * client comped (no billing, never paywalled, gates manual).
 *
 * ONE lock covers the provider call: the plan switch's mark
 * (`billing.retiringSubscriptionId` + `retiringSince`, see
 * `assignPlanToSubAccount`). Comp claims it in a transaction before it
 * calls the provider, so a switch can't start mid-comp and a comp can't
 * start mid-switch (each refuses while the other's mark holds), and the
 * subscription's own webhooks are muted while it is being retired. The
 * mark expires after 10 minutes like a switch's, so a crash can't wedge a
 * client. After a successful cancel the outcome always says the
 * subscription WAS cancelled, whatever happens to the write.
 */

/** What comping did. `failed`: the client was NOT comped; `cancelledSubscription`
 *  says whether the provider had cancelled a subscription anyway. */
export type CompResult =
  | { subscription: "cancelled" | "none" }
  | { subscription: "failed"; message: string; httpStatus: 409 | 502; cancelledSubscription: string | null };

const changing = (message: string): CompResult => ({ subscription: "failed", message, httpStatus: 409, cancelledSubscription: null });
const PLAN_CHANGE = changing("A plan change is in progress for this client — nothing changed; try again in a moment.");
const BILLING_CHANGED = changing("This client's billing changed while comping — nothing changed; try again.");

const switchMarked = (b: SubAccountBilling | null) =>
  !!b?.retiringSubscriptionId && isRetiring(b, b.retiringSubscriptionId);

const compedBilling = (fresh: SubAccountBilling | null) => ({
  status: "comped" satisfies SubAccountBillingStatus,
  planId: null,
  planName: null,
  priceCents: null,
  billingInterval: null,
  currency: null,
  specialPriceCents: null,
  stripePriceId: null,
  stripeCustomerId: fresh?.stripeCustomerId ?? null,
  stripeSubscriptionId: null,
  checkoutTokenHash: null,
  graceUntil: null,
  // Replacing the whole map drops the lock with it.
  assignedAt: fresh?.assignedAt ?? null,
  activatedAt: fresh?.activatedAt ?? null,
  updatedAt: FieldValue.serverTimestamp(),
});

export async function compSubAccount(input: { agencyId: string; subAccountId: string }): Promise<CompResult> {
  const db = getAdminDb();
  const ref = db.doc(`subAccounts/${input.subAccountId}`);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.agencyId !== input.agencyId) throw new BillingError("Sub-account not found", 404);
  const billing = readBilling(snap.data() as Record<string, unknown>);
  const subscriptionId = billing?.stripeSubscriptionId ?? null;
  // A cancelled subscription keeps its id on record (Paystack's disable
  // webhook leaves it there); it has nothing left to cancel.
  const live = !!subscriptionId && billing?.status !== "canceled";
  const comped = (cancelled: string | null): CompResult => {
    recordBillingEvent({
      agencyId: input.agencyId,
      subAccountId: input.subAccountId,
      event: "comped",
      detail: { previousStatus: billing?.status ?? null, canceledSubscription: cancelled },
    });
    return { subscription: cancelled ? "cancelled" : "none" };
  };

  if (!live) {
    // Nothing to cancel: comp in one transaction, unless the billing moved.
    const outcome = await db.runTransaction(async (tx) => {
      const fresh = readBilling(((await tx.get(ref)).data() ?? {}) as Record<string, unknown>);
      if (switchMarked(fresh)) return PLAN_CHANGE;
      if ((fresh?.stripeSubscriptionId ?? null) !== subscriptionId || (fresh?.status ?? null) !== (billing?.status ?? null)) {
        return BILLING_CHANGED;
      }
      tx.update(ref, { billing: compedBilling(fresh), updatedAt: FieldValue.serverTimestamp() });
      return null;
    });
    return outcome ?? comped(null);
  }

  // 1. Claim the lock before the provider is touched.
  const claimMs = Date.now();
  const claim = await db.runTransaction(async (tx) => {
    const fresh = readBilling(((await tx.get(ref)).data() ?? {}) as Record<string, unknown>);
    if (switchMarked(fresh)) return PLAN_CHANGE;
    if (fresh?.stripeSubscriptionId !== subscriptionId) return BILLING_CHANGED;
    tx.update(ref, {
      "billing.retiringSubscriptionId": subscriptionId,
      "billing.retiringSince": new Date(claimMs),
    });
    return null;
  });
  if (claim) return claim;
  /** Ours when it still names this subscription and this claim's instant. */
  const ours = (b: SubAccountBilling | null) =>
    b?.retiringSubscriptionId === subscriptionId && retiringSinceMs(b) === claimMs;
  const release = () =>
    db.runTransaction(async (tx) => {
      const fresh = readBilling(((await tx.get(ref)).data() ?? {}) as Record<string, unknown>);
      if (ours(fresh)) tx.update(ref, { "billing.retiringSubscriptionId": null, "billing.retiringSince": null });
    });

  // 2. Cancel. Any failure: the lock is released and nothing else changed.
  const provider = getBillingProvider();
  const name = provider.id === "paystack" ? "Paystack" : "Stripe";
  const notCancelled = (message: string): CompResult => ({ subscription: "failed", message, httpStatus: 502, cancelledSubscription: null });
  try {
    if (!provider.isConfigured()) {
      await release();
      return notCancelled("No payment provider is configured, so the client's subscription couldn't be cancelled — nothing changed.");
    }
    await provider.cancelSubscription(subscriptionId, billing?.stripeCustomerId ?? null);
  } catch (err) {
    console.warn("[billing] cancel-on-comp failed", err instanceof Error ? err.message : String(err));
    await release();
    return notCancelled(
      err instanceof SubscriptionNotOnAccount
        ? err.message
        : `Couldn't cancel the subscription with ${name} — nothing changed; try again or cancel it in the ${name} dashboard.`,
    );
  }

  // 3. Cancelled: comp + release in one transaction. From here the result
  //    always says the subscription was cancelled.
  const interrupted = (message: string, current: string | null): CompResult => {
    recordBillingEvent({
      agencyId: input.agencyId,
      subAccountId: input.subAccountId,
      event: "comp.interrupted",
      detail: { canceledSubscription: subscriptionId, currentSubscription: current },
    });
    return { subscription: "failed", message, httpStatus: 409, cancelledSubscription: subscriptionId };
  };
  let current: string | null;
  try {
    current = await db.runTransaction(async (tx) => {
      const fresh = readBilling(((await tx.get(ref)).data() ?? {}) as Record<string, unknown>);
      const now = fresh?.stripeSubscriptionId ?? null;
      // Still the subscription just cancelled: the client is not billed, so it is comped.
      if (now === subscriptionId) tx.update(ref, { billing: compedBilling(fresh), updatedAt: FieldValue.serverTimestamp() });
      else if (ours(fresh)) tx.update(ref, { "billing.retiringSubscriptionId": null, "billing.retiringSince": null });
      return now;
    });
  } catch (err) {
    console.error("[billing] comp write after cancel failed", err instanceof Error ? err.message : String(err));
    await release().catch(() => undefined);
    return interrupted(
      `Cancelled subscription ${subscriptionId} with ${name}, but the comp couldn't be saved — comp again to finish (it will find the subscription already ended).`,
      subscriptionId,
    );
  }
  if (current !== subscriptionId) {
    return interrupted(
      `Cancelled subscription ${subscriptionId} with ${name}, but the client moved to ${current ?? "no subscription"} meanwhile, so they were NOT comped${current ? ` and ${current} still bills` : ""}. Comp again to finish.`,
      current,
    );
  }
  return comped(subscriptionId);
}
