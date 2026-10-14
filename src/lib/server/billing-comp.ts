import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { getBillingProvider } from "@/lib/billing/provider";
import { BillingError, SubscriptionNotOnAccount } from "@/lib/billing/errors";
import { billingMarkMs, isComping, isRetiring, readBilling, recordBillingEvent } from "@/lib/server/billing-lifecycle";
import type { SubAccountBilling, SubAccountBillingStatus } from "@/types/billing";

/**
 * Comping a sub-account (Manage dialog + the assistant's comp_client):
 * cancel any live subscription on the payment provider, then mark the
 * client comped (no billing, never paywalled, gates manual).
 *
 * Comp holds its OWN lock across the provider call
 * (`billing.compingSubscriptionId` + `compingSince`), claimed in a
 * transaction before the provider is touched: a plan switch refuses to
 * start while it holds, and comp refuses while a switch's mark
 * (`retiringSubscriptionId`) holds. Unlike the switch's mark it mutes no
 * webhook — the subscription's own disable or payment_failed keeps
 * applying, so if comp then fails nothing the provider said is lost. It
 * lapses after 10 minutes like the switch's, so a crash can't wedge a client.
 *
 * Comped is written only while the stored subscription is the one comp
 * cancelled (whatever status its webhooks wrote meanwhile), or was cleared
 * because the provider ended it. A cancel call that failed is checked
 * against the provider: if the subscription reads ended, it WAS cancelled
 * and comp finishes. After a cancel, the outcome always says so.
 */

/** What comping did. `failed`: the client was NOT comped; `cancelledSubscription`
 *  says whether the provider had cancelled a subscription anyway. */
export type CompResult =
  | { subscription: "cancelled" | "none" }
  | { subscription: "failed"; message: string; httpStatus: 409 | 502; cancelledSubscription: string | null };

const changing = (message: string): CompResult => ({ subscription: "failed", message, httpStatus: 409, cancelledSubscription: null });
const PLAN_CHANGE = changing("A plan change is in progress for this client — nothing changed; try again in a moment.");
const BILLING_CHANGED = changing("This client's billing changed while comping — nothing changed; try again.");
const ANOTHER_COMP = changing("This client is already being comped — nothing changed; check their billing in a moment.");
const UNLOCK = { "billing.compingSubscriptionId": null, "billing.compingSince": null };
/** The final write's answer when a payment re-activated the client meanwhile. */
const REACTIVATED = Symbol("reactivated");

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
      if (isComping(fresh)) return ANOTHER_COMP;
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
  /** When the client was last activated, as the claim read it. */
  let activatedMs: number | null = null;
  /** The open checkout link the claim closed, reopened if comp doesn't happen. */
  let tokenHash: string | null = null;
  const claim = await db.runTransaction(async (tx) => {
    const fresh = readBilling(((await tx.get(ref)).data() ?? {}) as Record<string, unknown>);
    if (switchMarked(fresh)) return PLAN_CHANGE;
    if (isComping(fresh)) return ANOTHER_COMP;
    if (fresh?.stripeSubscriptionId !== subscriptionId) return BILLING_CHANGED;
    activatedMs = billingMarkMs(fresh?.activatedAt);
    tokenHash = fresh?.checkoutTokenHash ?? null;
    tx.update(ref, {
      "billing.compingSubscriptionId": subscriptionId,
      "billing.compingSince": new Date(claimMs),
      // An open activation checkout can't be paid mid-comp (reopened if
      // the comp doesn't happen).
      ...(tokenHash ? { "billing.checkoutTokenHash": null } : {}),
    });
    return null;
  });
  if (claim) return claim;
  /** Drop the lock. `reopen`: also reopen the checkout link the claim
   *  closed (unless one was minted since) — only when the cancel itself
   *  failed and nothing else moved; never after a payment re-activated the
   *  client (it consumed that link) or the subscription moved on. */
  const unlock = (fresh: SubAccountBilling | null, reopen: boolean) => ({
    ...UNLOCK,
    ...(reopen && tokenHash && !fresh?.checkoutTokenHash ? { "billing.checkoutTokenHash": tokenHash } : {}),
  });
  /** Ours when it still names this subscription and this claim's instant. */
  const ours = (b: SubAccountBilling | null) =>
    b?.compingSubscriptionId === subscriptionId && billingMarkMs(b.compingSince) === claimMs;
  const release = (reopen: boolean) =>
    db.runTransaction(async (tx) => {
      const fresh = readBilling(((await tx.get(ref)).data() ?? {}) as Record<string, unknown>);
      // A payment since the claim consumed the link: never revive it.
      if (ours(fresh)) tx.update(ref, unlock(fresh, reopen && billingMarkMs(fresh?.activatedAt) === activatedMs));
    });

  // 2. Cancel. A failure the provider's own record doesn't contradict: the
  //    lock is released and nothing else changed.
  const provider = getBillingProvider();
  const name = provider.id === "paystack" ? "Paystack" : "Stripe";
  const notCancelled = (message: string): CompResult => ({ subscription: "failed", message, httpStatus: 502, cancelledSubscription: null });
  try {
    if (!provider.isConfigured()) {
      await release(true);
      return notCancelled("No payment provider is configured, so the client's subscription couldn't be cancelled — nothing changed.");
    }
    await provider.cancelSubscription(subscriptionId, billing?.stripeCustomerId ?? null);
  } catch (err) {
    console.warn("[billing] cancel-on-comp failed", err instanceof Error ? err.message : String(err));
    // A timeout can hide a cancel that landed: the provider's record decides.
    const ended = await Promise.resolve()
      .then(() => provider.subscriptionEnded(subscriptionId))
      .catch(() => false);
    if (!ended) {
      await release(true);
      return notCancelled(
      err instanceof SubscriptionNotOnAccount
        ? err.message
        : `Couldn't cancel the subscription with ${name} — nothing changed; try again or cancel it in the ${name} dashboard.`,
      );
    }
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
  let current: string | null | typeof REACTIVATED;
  try {
    current = await db.runTransaction(async (tx) => {
      const fresh = readBilling(((await tx.get(ref)).data() ?? {}) as Record<string, unknown>);
      const now = fresh?.stripeSubscriptionId ?? null;
      // A payment activated the client since the claim: never comp over it.
      if (billingMarkMs(fresh?.activatedAt) !== activatedMs) {
        if (ours(fresh)) tx.update(ref, unlock(fresh, false));
        return REACTIVATED;
      }
      // Still the subscription just cancelled (whatever status its webhooks
      // wrote), or cleared because the provider ended it: nothing bills, so
      // it is comped.
      if (now === subscriptionId || (now === null && fresh?.status === "canceled")) {
        tx.update(ref, { billing: compedBilling(fresh), updatedAt: FieldValue.serverTimestamp() });
        return subscriptionId;
      }
      if (ours(fresh)) tx.update(ref, unlock(fresh, false));
      return now;
    });
  } catch (err) {
    console.error("[billing] comp write after cancel failed", err instanceof Error ? err.message : String(err));
    await release(false).catch(() => undefined);
    return interrupted(
      `Cancelled subscription ${subscriptionId} with ${name}, but the comp couldn't be saved — comp again to finish (it will find the subscription already ended).`,
      subscriptionId,
    );
  }
  if (current === REACTIVATED) {
    return interrupted(
      `Cancelled subscription ${subscriptionId} with ${name}, but the client paid a new checkout meanwhile, so they were NOT comped — refund that payment, or comp again to stop their new subscription.`,
      null,
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
