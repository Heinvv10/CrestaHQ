import { describe, expect, it } from "vitest";
import { checkoutSlugError } from "./checkout-pages";

describe("checkoutSlugError", () => {
  it("reserves every slug that shadows a sibling /co route", () => {
    for (const slug of ["api", "new", "thanks", "preview", "buy"]) {
      expect(checkoutSlugError(slug), slug).toContain("reserved");
    }
  });

  it("accepts an ordinary slug", () => {
    expect(checkoutSlugError("buy-now")).toBeNull();
  });
});
