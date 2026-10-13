import { describe, expect, it } from "vitest";
import { publicBookingStyle } from "@/lib/booking/public-style";

/** The style fields a public booking page may send to the browser. */
describe("publicBookingStyle", () => {
  it("passes what the app writes", () => {
    expect(publicBookingStyle({ accentColor: "#FF5500", themePreset: "ocean" })).toEqual({ accentColor: "#FF5500", themePreset: "ocean" });
    expect(publicBookingStyle({ accentColor: "#F50", themePreset: null })).toEqual({ accentColor: "#F50", themePreset: null });
  });

  it("returns null for a missing page or missing fields", () => {
    const none = { accentColor: null, themePreset: null };
    expect(publicBookingStyle(null)).toEqual(none);
    expect(publicBookingStyle(undefined)).toEqual(none);
    expect(publicBookingStyle({})).toEqual(none);
  });

  it("drops anything else", () => {
    for (const bad of ["red", "#FF5500;color:red", "url(x)", "</script>", "", 42, ["#FF5500"], { toString: () => "#FF5500" }]) {
      expect(publicBookingStyle({ accentColor: bad }).accentColor, JSON.stringify(bad)).toBeNull();
    }
    for (const bad of ["bogus", "Ocean", "constructor", "__proto__", "ocean;x", "", 42, ["ocean"], { id: "ocean" }]) {
      expect(publicBookingStyle({ themePreset: bad }).themePreset, JSON.stringify(bad)).toBeNull();
    }
  });
});
