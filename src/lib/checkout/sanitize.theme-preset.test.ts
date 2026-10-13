import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => ({}) }));

const { CheckoutPageError, sanitizeCheckoutPagePayload } = await import("@/lib/checkout/sanitize");
const { CHECKOUT_THEME_IDS } = await import("@/types/checkout-pages");

/** The style preset in a checkout page's save payload. */
describe("sanitizeCheckoutPagePayload themePreset", () => {
  it("keeps a known preset", () => {
    for (const id of CHECKOUT_THEME_IDS) {
      expect(sanitizeCheckoutPagePayload({ themePreset: id })).toEqual({ themePreset: id });
    }
  });

  it("clears the preset on null or empty, and leaves it alone when absent", () => {
    expect(sanitizeCheckoutPagePayload({ themePreset: null })).toEqual({ themePreset: null });
    expect(sanitizeCheckoutPagePayload({ themePreset: "" })).toEqual({ themePreset: null });
    expect(sanitizeCheckoutPagePayload({ name: "A" })).toEqual({ name: "A" });
  });

  it("refuses an unknown preset instead of storing it", () => {
    for (const themePreset of ["bogus", "Clean", "constructor", "__proto__", "clean;color:red", 42, {}, ["clean"]]) {
      let thrown: unknown = null;
      try {
        sanitizeCheckoutPagePayload({ themePreset: themePreset as never });
      } catch (err) {
        thrown = err;
      }
      expect(thrown, JSON.stringify(themePreset)).toBeInstanceOf(CheckoutPageError);
      expect((thrown as InstanceType<typeof CheckoutPageError>).message).toBe("Unknown style preset.");
      expect((thrown as InstanceType<typeof CheckoutPageError>).status).toBe(400);
    }
  });
});
