import { describe, expect, it } from "vitest";

import { canPayInvoice, canTakePayment } from "./can-take-payment";

/**
 * The invoice editors' "No payment method is connected" banner reads
 * `canPayInvoice`. A Paystack connection pays an invoice (a link emailed with
 * it) but not a booking, so it counts there and NOT in `canTakePayment`.
 */

const paystack = { webhookSeenAt: null, webhookUrl: null, currencies: ["ZAR"], livemode: false, keyLast4: "1234", connectedAt: new Date() };

describe("canPayInvoice", () => {
  it("counts a Paystack connection when the agency has Payments on", () => {
    const sub = { paymentsEnabledByAgency: true, paystackConnectionMeta: paystack };
    expect(canPayInvoice(sub)).toBe(true);
    expect(canTakePayment(sub)).toBe(false);
  });

  it("does not count Paystack when Payments is off, or when it is disconnected", () => {
    expect(canPayInvoice({ paymentsEnabledByAgency: false, paystackConnectionMeta: paystack })).toBe(false);
    expect(canPayInvoice({ paymentsEnabledByAgency: true, paystackConnectionMeta: null })).toBe(false);
  });

  it("still counts PayPal and a ready Stripe", () => {
    expect(canPayInvoice({ paypalConfig: { username: "acme" } } as never)).toBe(true);
    expect(canPayInvoice({ paymentsEnabledByAgency: true, stripeConnectionMeta: { ready: true } } as never)).toBe(true);
  });
});
