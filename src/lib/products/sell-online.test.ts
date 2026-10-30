import { describe, expect, it } from "vitest";

import {
  MAX_SELL_ONLINE_PRICE_CENTS,
  productSlugError,
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
    [1, "USD"],
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
  ])("%s → refused", (_label, cents, currency) => {
    expect(sellOnlinePriceError(cents, currency)).not.toBeNull();
  });
});
