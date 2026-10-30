import { describe, expect, it } from "vitest";

import {
  MAX_SELL_ONLINE_PRICE_CENTS,
  minSellOnlinePriceCents,
  productSlugError,
  SELL_ONLINE_CURRENCIES,
  sellOnlinePriceError,
  slugifyProductSlug,
} from "./sell-online";

describe("productSlugError", () => {
  it.each(["ab", "fibre-100", "a1", "x".repeat(60)])("%s → ok", (slug) => {
    expect(productSlugError(slug)).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["one character", "a"],
    ["61 characters", "x".repeat(61)],
    ["upper case", "Fibre"],
    ["leading hyphen", "-fibre"],
    ["trailing hyphen", "fibre-"],
    ["a slash", "a/b"],
    ["a dot", "a.b"],
    ["a space", "a b"],
    ["reserved buy", "buy"],
    ["reserved thanks", "thanks"],
    ["reserved api", "api"],
  ])("%s → refused", (_label, slug) => {
    expect(productSlugError(slug)).not.toBeNull();
  });

  it("slugify output of a 70-char name fits and has no trailing hyphen", () => {
    const slug = slugifyProductSlug(`${"a".repeat(59)} b ${"c".repeat(10)}`);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(productSlugError(slug)).toBeNull();
  });
});

describe("sellOnlinePriceError", () => {
  it.each([
    [50, "USD"],
    [30, "GBP"],
    [400, "HKD"],
    [5_000, "JPY"],
    [50, "ZAR"],
    [49_900, "ZAR"],
    [MAX_SELL_ONLINE_PRICE_CENTS, "EUR"],
    [123_00, "JPY"],
  ])("%s %s → ok", (cents, currency) => {
    expect(sellOnlinePriceError(cents, currency)).toBeNull();
  });

  it.each([
    ["zero", 0, "USD"],
    ["negative", -100, "USD"],
    ["fractional cents", 10.5, "USD"],
    ["NaN", Number.NaN, "USD"],
    ["a string", "100", "USD"],
    ["missing", undefined, "USD"],
    ["over the cap", MAX_SELL_ONLINE_PRICE_CENTS + 1, "USD"],
    ["a currency outside the list", 100, "XYZ"],
    ["a three-decimal currency", 100, "KWD"],
    ["lower-case currency", 100, "usd"],
    ["no currency", 100, undefined],
    ["a zero-decimal price with cents (¥123.45)", 12_345, "JPY"],
    ["below Stripe's minimum (USD 0.49)", 49, "USD"],
    ["below Stripe's minimum (GBP 0.29)", 29, "GBP"],
    ["below Stripe's minimum (HKD 3.99)", 399, "HKD"],
    ["below Stripe's minimum (JPY 49)", 4_900, "JPY"],
    ["below Stripe's minimum (ZAR 0.49)", 49, "ZAR"],
  ])("%s → refused", (_label, cents, currency) => {
    expect(sellOnlinePriceError(cents, currency)).not.toBeNull();
  });
});

describe("minSellOnlinePriceCents", () => {
  it("has Stripe's documented minimum for every sell-online currency", () => {
    for (const c of SELL_ONLINE_CURRENCIES) expect(minSellOnlinePriceCents(c)).toBeGreaterThan(0);
    expect(minSellOnlinePriceCents("USD")).toBe(50);
    expect(minSellOnlinePriceCents("JPY")).toBe(5_000);
  });

  it("refuses below 100 minor units for a currency it doesn't know", () => {
    expect(minSellOnlinePriceCents("XYZ")).toBe(100);
  });
});
