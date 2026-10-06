import { describe, expect, it, vi } from "vitest";
import { restoreBillingProviderAfterEach, spyBillingProvider, type ProviderKind } from "@/test/billing-provider-spies";

/**
 * A charge or a plan priced in a currency the configured provider can't
 * settle is refused at validate — the Agency Assistant and an agent key
 * alike (A4b review, MEDIUM 2). Amounts are kept in hundredths, so on Stripe
 * a zero-decimal currency would bill 100× (JPY 500 sent as 50000) and a
 * three-decimal one can't be priced at all; Paystack settles only its own
 * list.
 */

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => ({}) }));

const { getCapability } = await import("@/lib/ai-suite/capabilities");

restoreBillingProviderAfterEach();

const charge = (currency: string) =>
  getCapability("create_one_time_charge")!.validate({ subAccountId: "sa1", description: "Web design", amount: 500, currency });
const plan = (currency: string) => getCapability("create_billing_plan")!.validate({ name: "Pro", priceMonthly: 99, currency });

describe.each([["create_one_time_charge", charge], ["create_billing_plan", plan]] as const)("%s", (_name, validate) => {
  it.each([
    ["stripe", "jpy", /JPY/],
    ["stripe", "krw", /KRW/],
    ["stripe", "kwd", /KWD/],
    ["none", "jpy", /JPY/],
    ["paystack", "eur", /Paystack can't settle EUR/],
    // No subunit, and Paystack's handling of its amount is unconfirmed: a possible 100x.
    ["paystack", "xof", /XOF/],
  ] as const)("on %s, %s is refused", (kind, currency, message) => {
    spyBillingProvider(kind as ProviderKind);
    expect(validate(currency)).toEqual({ ok: false, error: expect.stringMatching(message) });
  });

  it.each([
    ["stripe", "zar"],
    ["stripe", "usd"],
    ["stripe", "eur"],
    ["paystack", "zar"],
    // A white-label buyer's Paystack merchant may settle in another of its currencies.
    ["paystack", "ngn"],
    ["paystack", "kes"],
  ] as const)("on %s, %s is accepted", (kind, currency) => {
    spyBillingProvider(kind);
    expect(validate(currency)).toMatchObject({ ok: true, args: { currency } });
  });
});

describe.each([
  ["create_one_time_charge", () => getCapability("create_one_time_charge")!.validate({ subAccountId: "sa1", description: "Web design", amount: 500 })],
  ["create_billing_plan", () => getCapability("create_billing_plan")!.validate({ name: "Pro", priceMonthly: 99 })],
] as const)("%s with no currency", (_name, validate) => {
  it.each([["paystack", "zar"], ["stripe", "usd"], ["none", "usd"]] as const)("on %s defaults to %s", (kind, currency) => {
    spyBillingProvider(kind);
    expect(validate()).toMatchObject({ ok: true, args: { currency } });
  });
});
