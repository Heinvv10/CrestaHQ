import { describe, expect, it } from "vitest";
import { defaultBookingPageFormData } from "@/lib/booking/defaults";
import { validateBookingPageFormData, validateThemePreset } from "@/lib/booking/validation";
import { CHECKOUT_THEME_IDS } from "@/types/checkout-pages";

/** The style preset of a booking page's save payload (shared with checkout pages). */

const base = { ...defaultBookingPageFormData("demo", "UTC"), name: "Demo" };

describe("validateThemePreset", () => {
  it("accepts every known preset", () => {
    for (const id of CHECKOUT_THEME_IDS) {
      expect(validateThemePreset(id)).toEqual({ ok: true, value: id });
    }
  });

  it("reads null, absent and empty as no preset", () => {
    for (const v of [null, undefined, ""]) {
      expect(validateThemePreset(v)).toEqual({ ok: true, value: null });
    }
  });

  it("refuses an unknown preset", () => {
    for (const v of ["bogus", "Clean", "constructor", "__proto__", "clean;color:red", 42, {}, ["clean"], true]) {
      expect(validateThemePreset(v), JSON.stringify(v)).toEqual({ ok: false, error: "Unknown style preset." });
    }
  });
});

describe("validateBookingPageFormData themePreset", () => {
  it("a new page has no preset", () => {
    expect(base.themePreset).toBeNull();
    const v = validateBookingPageFormData(base);
    expect(v.ok && v.value.themePreset).toBeNull();
  });

  it("a body without the field saves no preset", () => {
    const { themePreset: _omit, ...body } = base;
    const v = validateBookingPageFormData(body);
    expect(v.ok && v.value.themePreset).toBeNull();
  });

  it("saves a known preset and refuses the whole body for an unknown one", () => {
    const ok = validateBookingPageFormData({ ...base, themePreset: "noir-lime" });
    expect(ok.ok && ok.value.themePreset).toBe("noir-lime");
    expect(validateBookingPageFormData({ ...base, themePreset: "bogus" })).toEqual({ ok: false, error: "Unknown style preset." });
  });
});
