import { describe, it, expect } from "vitest";
import { resolveWhatsAppProviderId, capabilitiesFor } from "./provider";

describe("resolveWhatsAppProviderId", () => {
  it.each([undefined, null, "", "TWILIO", "meta", "garbage"])(
    "falls back to twilio for %p",
    (raw) => {
      // Every workspace predating the seam has no field. Reading undefined as
      // anything but twilio silently reroutes a live rail.
      expect(resolveWhatsAppProviderId(raw as string | null)).toBe("twilio");
    },
  );

  it.each(["twilio", "cloud", "bridge"] as const)("passes through %s", (p) => {
    expect(resolveWhatsAppProviderId(p)).toBe(p);
  });
});

describe("capabilitiesFor", () => {
  it("gives both Meta rails a window and templates", () => {
    for (const p of ["twilio", "cloud"] as const) {
      expect(capabilitiesFor(p)).toEqual({
        supportsTemplates: true,
        enforcesWindow: true,
      });
    }
  });

  it("gives the bridge neither", () => {
    // Stated, not inferred. The bridge is not a Meta rail: no service window
    // exists to enforce and no template can be sent.
    expect(capabilitiesFor("bridge")).toEqual({
      supportsTemplates: false,
      enforcesWindow: false,
    });
  });
});
