import { describe, expect, it } from "vitest";

import { chooseProductPayRail } from "./product-pay-rail";
import type { SubAccountDoc } from "@/types/tenancy";

/**
 * The one rail rule for products sold online (plan F + Decision 2): Stripe
 * when it is ready and can price the currency, else Paystack for ZAR, else a
 * reason the editor shows.
 */

const STRIPE_READY = { ready: true } as SubAccountDoc["stripeConnectionMeta"];
const STRIPE_UNREADY = { ready: false } as SubAccountDoc["stripeConnectionMeta"];
const PAYSTACK = { keyLast4: "45a2" } as SubAccountDoc["paystackConnectionMeta"];

const sub = (patch: Partial<SubAccountDoc>): Partial<SubAccountDoc> => ({
  sellOnlineEnabledByAgency: true,
  paymentsEnabledByAgency: true,
  ...patch,
});

describe("chooseProductPayRail", () => {
  it.each([
    ["Stripe only, USD", { stripeConnectionMeta: STRIPE_READY }, "USD", "stripe"],
    ["Stripe only, ZAR", { stripeConnectionMeta: STRIPE_READY }, "ZAR", "stripe"],
    ["Paystack only, ZAR", { paystackConnectionMeta: PAYSTACK }, "ZAR", "paystack"],
    ["Paystack only, lower-case zar", { paystackConnectionMeta: PAYSTACK }, "zar", "paystack"],
    ["both, ZAR → Stripe first (Decision 2)", { stripeConnectionMeta: STRIPE_READY, paystackConnectionMeta: PAYSTACK }, "ZAR", "stripe"],
    ["both, USD → Stripe", { stripeConnectionMeta: STRIPE_READY, paystackConnectionMeta: PAYSTACK }, "USD", "stripe"],
    ["both, Stripe can't price KWD, not ZAR either", { stripeConnectionMeta: STRIPE_READY, paystackConnectionMeta: PAYSTACK }, "KWD", null],
    ["Stripe not ready, Paystack, ZAR → Paystack", { stripeConnectionMeta: STRIPE_UNREADY, paystackConnectionMeta: PAYSTACK }, "ZAR", "paystack"],
  ])("%s", (_label, patch, currency, rail) => {
    const got = chooseProductPayRail(sub(patch), currency);
    expect(got).toEqual(rail ? { ok: true, rail } : { ok: false, reason: expect.any(String) });
  });

  it("neither connected → connect first", () => {
    expect(chooseProductPayRail(sub({}), "ZAR")).toEqual({
      ok: false,
      reason: "Connect Stripe or Paystack under Settings → Payments first.",
    });
  });

  it("non-ZAR on a Paystack-only workspace → refused, naming ZAR and the currency", () => {
    const got = chooseProductPayRail(sub({ paystackConnectionMeta: PAYSTACK }), "USD");
    expect(got.ok).toBe(false);
    expect(!got.ok && got.reason).toBe("Paystack only takes ZAR, and this product is priced in USD.");
  });

  it("Stripe connected but not ready (webhook step) → not a rail", () => {
    const got = chooseProductPayRail(sub({ stripeConnectionMeta: STRIPE_UNREADY }), "USD");
    expect(got.ok).toBe(false);
    expect(!got.ok && got.reason).toMatch(/Stripe isn't ready yet/);
  });

  it("Stripe can't price a three-decimal currency", () => {
    const got = chooseProductPayRail(sub({ stripeConnectionMeta: STRIPE_READY }), "KWD");
    expect(!got.ok && got.reason).toBe("Stripe can't charge KWD.");
  });

  it.each([
    ["sell-online gate off", { sellOnlineEnabledByAgency: false }, /Selling online is turned off/],
    ["sell-online gate absent", { sellOnlineEnabledByAgency: undefined }, /Selling online is turned off/],
    ["Payments off", { paymentsEnabledByAgency: false }, /Payments is turned off/],
  ])("%s → refused even with both rails connected", (_label, patch, reason) => {
    const got = chooseProductPayRail(
      sub({ stripeConnectionMeta: STRIPE_READY, paystackConnectionMeta: PAYSTACK, ...patch }),
      "ZAR",
    );
    expect(got.ok).toBe(false);
    expect(!got.ok && got.reason).toMatch(reason);
  });

  it("no sub-account doc → refused", () => {
    expect(chooseProductPayRail(null, "ZAR").ok).toBe(false);
  });
});
