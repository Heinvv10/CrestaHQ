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
        supportsMedia: false,
      });
    }
  });

  it("gives the bridge neither, and gives it media", () => {
    // Stated, not inferred. The bridge is not a Meta rail: no service window
    // exists to enforce and no template can be sent. It is also the only rail
    // that uploads a file directly, which is why media is declared here rather
    // than derived from a provider-name comparison at the call site.
    expect(capabilitiesFor("bridge")).toEqual({
      supportsTemplates: false,
      enforcesWindow: false,
      supportsMedia: true,
    });
  });

  it("declares media support for every rail, so a new one cannot inherit it", () => {
    // The failure this guards: a fourth rail added with a partial capability
    // record, defaulting to whatever `provider !== "bridge"` used to produce.
    for (const p of ["twilio", "cloud", "bridge"] as const) {
      expect(typeof capabilitiesFor(p).supportsMedia).toBe("boolean");
    }
  });
});
