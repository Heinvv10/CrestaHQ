import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Paystack event router — where a client's payment becomes an active
 * workspace. Every test here is a case where handling the event wrongly either
 * leaves a paying client walled out or activates one who has not paid.
 */

const activateSubAccountPlan = vi.fn();
const recordSubAccountSubscriptionId = vi.fn();
const applySubAccountSubscriptionStatus = vi.fn();
const markSubAccountChargePaid = vi.fn();

vi.mock("@/lib/server/billing-service", () => ({
  activateSubAccountPlan: (...a: unknown[]) => activateSubAccountPlan(...a),
  applySubAccountSubscriptionStatus: (...a: unknown[]) =>
    applySubAccountSubscriptionStatus(...a),
  markSubAccountChargePaid: (...a: unknown[]) => markSubAccountChargePaid(...a),
  recordSubAccountSubscriptionId: (...a: unknown[]) =>
    recordSubAccountSubscriptionId(...a),
}));

// Plan and charge payments are settled on Paystack's verified record — the
// seam test for that is `app/api/webhooks/paystack/route.verify.test.ts`.
// Here only the routing is asserted.
const settleClientBillingPayment = vi.fn();
vi.mock("./client-billing-payment", async (importActual) => ({
  ...(await importActual<typeof import("./client-billing-payment")>()),
  settleClientBillingPayment: (...a: unknown[]) => settleClientBillingPayment(...a),
}));

const { handlePaystackEvent } = await import("./webhooks");

const CUSTOMER = { customer_code: "CUS_1" };

beforeEach(() => vi.clearAllMocks());

describe("charge.success — a plan's first payment or a one-time charge", () => {
  const planCharge = {
    event: "charge.success",
    data: {
      reference: "ref_1",
      customer: CUSTOMER,
      metadata: {
        kind: "subAccountPlan",
        subAccountId: "sa_1",
        planId: "plan_1",
      },
    },
  };

  it("settles a plan payment by its reference, activating nothing from the body", async () => {
    await handlePaystackEvent(planCharge);
    expect(settleClientBillingPayment).toHaveBeenCalledWith("ref_1");
    // The body's metadata and amount are payer-controlled; activation happens
    // only after Paystack's verify endpoint confirms the money.
    expect(activateSubAccountPlan).not.toHaveBeenCalled();
  });

  it("reads metadata Paystack echoed back as a JSON string", async () => {
    await handlePaystackEvent({
      ...planCharge,
      data: { ...planCharge.data, metadata: JSON.stringify(planCharge.data.metadata) },
    });
    expect(settleClientBillingPayment).toHaveBeenCalledWith("ref_1");
  });

  it("settles a one-time charge by its reference, marking nothing from the body", async () => {
    await handlePaystackEvent({
      event: "charge.success",
      data: {
        id: 998877,
        reference: "ref_2",
        customer: CUSTOMER,
        metadata: { kind: "subAccountCharge", chargeId: "ch_1" },
      },
    });
    expect(settleClientBillingPayment).toHaveBeenCalledWith("ref_2");
    expect(markSubAccountChargePaid).not.toHaveBeenCalled();
  });
});

describe("charge.success — a renewal", () => {
  const renewal = {
    event: "charge.success",
    data: {
      reference: "ref_3",
      customer: CUSTOMER,
      // A renewal carries no metadata of ours, and names a PLAN, not a
      // subscription.
      metadata: "",
      plan: { plan_code: "PLN_m" },
    },
  };

  it("clears dunning by the customer, without inventing a subscription id", async () => {
    await handlePaystackEvent(renewal);
    expect(applySubAccountSubscriptionStatus).toHaveBeenCalledWith(
      expect.objectContaining({ matchPriceId: "PLN_m" }),
    );
    // Storing the plan code as the subscription id would repoint the workspace
    // at an object that cannot be cancelled.
    expect(applySubAccountSubscriptionStatus).toHaveBeenCalledWith({
      subscriptionId: null,
      status: "active",
      deleted: false,
      customerIdHint: "CUS_1",
      matchPriceId: "PLN_m",
      providerStatus: "charge.success",
    });
  });

  it("ignores a charge carrying no plan — it is not a subscription renewal", async () => {
    // charge.success fires for EVERY charge on the agency's Paystack account.
    // A lapsed client paying the agency for something else must not unlock the
    // plan they have not paid for.
    await handlePaystackEvent({
      ...renewal,
      data: { ...renewal.data, plan: null },
    });
    expect(applySubAccountSubscriptionStatus).not.toHaveBeenCalled();
  });

  it("does nothing when there is no customer to identify", async () => {
    await handlePaystackEvent({
      ...renewal,
      data: { ...renewal.data, customer: null },
    });
    expect(applySubAccountSubscriptionStatus).not.toHaveBeenCalled();
  });
});

describe("subscription.create", () => {
  it("stores the subscription code, the only event that carries it", async () => {
    await handlePaystackEvent({
      event: "subscription.create",
      data: { subscription_code: "SUB_1", customer: CUSTOMER },
    });
    expect(recordSubAccountSubscriptionId).toHaveBeenCalledWith({
      customerId: "CUS_1",
      subscriptionId: "SUB_1",
    });
  });

  it("does NOT activate — a subscription object is not proof money moved", async () => {
    await handlePaystackEvent({
      event: "subscription.create",
      data: { subscription_code: "SUB_1", customer: CUSTOMER },
    });
    // This event can arrive BEFORE the payment. Activating here would unlock
    // the workspace at whatever gates it held while pending, fire a second
    // billing.activated, and leave its checkout link live.
    expect(applySubAccountSubscriptionStatus).not.toHaveBeenCalled();
    expect(activateSubAccountPlan).not.toHaveBeenCalled();
  });

  it("ignores an event with no subscription code to record", async () => {
    await handlePaystackEvent({
      event: "subscription.create",
      data: { customer: CUSTOMER },
    });
    expect(recordSubAccountSubscriptionId).not.toHaveBeenCalled();
  });

  it("ignores an event with no customer to attach it to", async () => {
    await handlePaystackEvent({
      event: "subscription.create",
      data: { subscription_code: "SUB_1", customer: null },
    });
    expect(recordSubAccountSubscriptionId).not.toHaveBeenCalled();
  });
});

describe("failed and ended subscriptions", () => {
  it("moves a failed renewal to past_due so the grace window starts", async () => {
    await handlePaystackEvent({
      event: "invoice.payment_failed",
      data: {
        customer: CUSTOMER,
        subscription: { subscription_code: "SUB_1" },
      },
    });
    expect(applySubAccountSubscriptionStatus).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: "SUB_1", status: "past_due" }),
    );
  });

  it("cancels on subscription.disable without clearing the stored code", async () => {
    await handlePaystackEvent({
      event: "subscription.disable",
      data: { subscription_code: "SUB_1", customer: CUSTOMER },
    });
    expect(applySubAccountSubscriptionStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "canceled",
        // Keeping the code is how the agency can still see what happened.
        deleted: false,
      }),
    );
  });

  it("does NOT cancel on not_renew — the paid period still has to run", async () => {
    await handlePaystackEvent({
      event: "subscription.not_renew",
      data: { subscription_code: "SUB_1", customer: CUSTOMER },
    });
    // not_renew means auto-renew was switched off, leaving the subscription
    // "active, non-renewing". Cancelling here paywalls someone for the weeks
    // they have already paid for. `subscription.disable` arrives when the
    // period actually expires; that is the terminating event.
    expect(applySubAccountSubscriptionStatus).not.toHaveBeenCalled();
  });
});

describe("events Client Billing does not map", () => {
  it("changes nothing on a transfer or a refund", async () => {
    // Paystack sends far more than billing cares about. Acting on an unmapped
    // event is how a refund on an unrelated transfer cancels someone's plan.
    for (const event of ["transfer.success", "refund.processed", "charge.dispute.create"]) {
      await handlePaystackEvent({ event, data: { customer: CUSTOMER } });
    }
    expect(activateSubAccountPlan).not.toHaveBeenCalled();
    expect(applySubAccountSubscriptionStatus).not.toHaveBeenCalled();
    expect(markSubAccountChargePaid).not.toHaveBeenCalled();
    expect(recordSubAccountSubscriptionId).not.toHaveBeenCalled();
  });
});
