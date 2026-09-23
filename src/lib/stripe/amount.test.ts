import { expect, it } from "vitest";

import {
  centsToStripeAmount,
  stripeAmountToCents,
  stripeCanChargeCurrency,
  toStripeAmount,
} from "./amount";

// https://docs.stripe.com/currencies — zero-decimal list and "Special cases".
it("sends zero-decimal currencies in whole units", () => {
  expect(toStripeAmount(1150, "JPY")).toBe(1150);
  expect(toStripeAmount(5000, "krw")).toBe(5000);
  expect(stripeAmountToCents(1150, "jpy")).toBe(115000);
});

it("sends the special cases (UGX, ISK, HUF, TWD) as two-decimal values", () => {
  for (const c of ["UGX", "ISK", "HUF", "TWD"]) {
    expect(toStripeAmount(5, c)).toBe(500);
    expect(stripeAmountToCents(500, c)).toBe(500);
  }
});

it("sends two-decimal currencies in cents", () => {
  expect(toStripeAmount(12.5, "usd")).toBe(1250);
  expect(centsToStripeAmount(115000, "zar")).toBe(115000);
  expect(centsToStripeAmount(115000, "jpy")).toBe(1150);
});

it("refuses three-decimal currencies rather than charging a tenth", () => {
  for (const c of ["BHD", "JOD", "KWD", "OMR", "TND"]) {
    expect(stripeCanChargeCurrency(c)).toBe(false);
    expect(() => toStripeAmount(10, c)).toThrow();
  }
  expect(stripeCanChargeCurrency("usd")).toBe(true);
});
