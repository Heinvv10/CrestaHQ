import "server-only";

import {
  createPaystackSubscription,
  disablePaystackSubscription,
  findLivePaystackSubscriptionOnPlan,
  readPaystackSubscription,
} from "@/lib/paystack/billing-api";
import { BillingError } from "./errors";
import type { SwitchSubscriptionInput } from "./provider";

/**
 * Paystack cannot move a live subscription onto another plan, so the switch
 * is a fresh subscription starting the day the old one would have renewed,
 * plus a disable of the old one — the client is never double-charged and
 * never gets a free period.
 *
 * The new one is opened FIRST, starting at the old one's renewal date (or
 * now, for a past-due subscription whose renewal is already owed — see
 * `createPaystackSubscription`), and the old one is disabled straight after,
 * so it never bills again. Disabling first left a window with no live
 * subscription at all, in which the old one's disable webhook could paywall
 * a paying client. Two switches at once are prevented by the caller's lock.
 *
 * The returned id is a NEW subscription code and the caller must store it —
 * the one it passed in is dead by the time this returns.
 *
 * `metadata` is unused: Paystack's subscription-create endpoint takes none.
 */
export async function switchPaystackSubscriptionPlan(
  input: SwitchSubscriptionInput,
): Promise<{ subscriptionId: string }> {
  if (input.timing === "immediate_prorated") {
    throw new BillingError(
      "Paystack can't prorate a mid-cycle switch — apply it at the renewal date instead.",
      501,
    );
  }
  const sub = await readPaystackSubscription(input.subscriptionId);
  // The stored subscription must still be the one billing. If it is not, an
  // earlier switch may have opened a replacement and died before storing it —
  // switching again would open a third while that one bills untracked.
  if (sub.status !== "active" && sub.status !== "attention") {
    throw new BillingError(
      `This workspace's Paystack subscription ${sub.subscription_code} is no longer active (${sub.status ?? "unknown"}). Check customer ${sub.customer?.customer_code ?? "(unknown)"} in the Paystack dashboard before re-assigning — an earlier switch may already have started a new subscription.`,
      409,
    );
  }
  const authorizationCode = sub.authorization?.authorization_code;
  const customerCode = sub.customer?.customer_code;
  if (!authorizationCode || !customerCode || !sub.next_payment_date) {
    throw new BillingError(
      "This Paystack subscription has no saved card or renewal date — switch it in the Paystack dashboard.",
      500,
    );
  }

  const subscriptionId = await startReplacement({
    old: sub.subscription_code,
    customerCode,
    planCode: input.priceId,
    authorizationCode,
    startDate: sub.next_payment_date,
  });

  try {
    await disablePaystackSubscription(sub);
    return { subscriptionId };
  } catch (err) {
    // The disable may have landed with only its answer lost. Ask.
    const oldStillBills = await readPaystackSubscription(sub.subscription_code).then(
      (s) => s.status === "active" || s.status === "attention",
      () => null,
    );
    if (oldStillBills === false) return { subscriptionId };
    const detail = err instanceof Error ? err.message : String(err);
    if (oldStillBills === true) {
      // Undo: the client stays on the plan they have.
      const undone = await readPaystackSubscription(subscriptionId)
        .then(disablePaystackSubscription)
        .then(() => true, () => false);
      if (undone) {
        throw new BillingError(
          `The plan switch didn't go through, so nothing changed — the client is still on their current plan. (${detail})`,
          502,
        );
      }
    }
    console.error(
      `[billing] Paystack plan switch left two subscriptions possibly live: ${sub.subscription_code} (old) and ${subscriptionId} (new)`,
      err,
    );
    throw new BillingError(
      `Paystack may be billing this client on both ${sub.subscription_code} (old plan) and ${subscriptionId} (new plan). Cancel one in the Paystack dashboard before the renewal date. (${detail})`,
      502,
    );
  }
}

/**
 * Open the subscription a plan switch moves to. A failed create is not taken
 * at its word: a slow POST can time out here and still succeed at Paystack,
 * and telling the agency to "re-assign" then opens a second live
 * subscription. So Paystack is asked whether the subscription exists before
 * anyone is told anything.
 */
async function startReplacement(input: {
  old: string;
  customerCode: string;
  planCode: string;
  authorizationCode: string;
  startDate: string;
}): Promise<string> {
  const startedAt = Date.now();
  try {
    return await createPaystackSubscription(input);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    let started: string | null;
    try {
      started = await findLivePaystackSubscriptionOnPlan(input.customerCode, input.planCode, {
        excludeCode: input.old,
        // Paystack's clock and ours differ; a minute of slack is plenty.
        createdSince: startedAt - 60_000,
      });
    } catch (probeErr) {
      console.error(
        `[billing] Paystack plan switch for ${input.old}: create failed and the follow-up check failed too`,
        err,
        probeErr,
      );
      throw new BillingError(unconfirmed(input.customerCode, detail), 502);
    }
    if (started) return started;
    // Only Paystack refusing the request (a 4xx) proves nothing was created.
    // A timeout, a 5xx or a success without a code may still become a live
    // subscription after this check, so it is reported as unknown.
    const refused =
      err instanceof BillingError &&
      err.providerStatus !== undefined &&
      err.providerStatus >= 400 &&
      err.providerStatus < 500;
    if (!refused) {
      console.error(`[billing] Paystack plan switch for ${input.old}: create outcome unknown`, err);
      throw new BillingError(unconfirmed(input.customerCode, detail), 502);
    }
    throw new BillingError(
      `The new plan didn't start, so nothing changed — the client is still on their current plan. (${detail})`,
      502,
    );
  }
}

function unconfirmed(customerCode: string, detail: string): string {
  return `Paystack didn't confirm whether the new plan started. The client's current plan is untouched. Check customer ${customerCode} in the Paystack dashboard before re-assigning — re-assigning now could open a second subscription. (${detail})`;
}
