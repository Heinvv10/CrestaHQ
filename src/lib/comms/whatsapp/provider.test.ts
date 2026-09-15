import { readFileSync } from "node:fs";
import { join } from "node:path";
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
      expect(capabilitiesFor(p)).toMatchObject({
        supportsTemplates: true,
        enforcesWindow: true,
      });
    }
  });

  it("gives the bridge neither, and gives it media", () => {
    // Stated, not inferred. The bridge is not a Meta rail: no service window
    // exists to enforce and no template can be sent.
    expect(capabilitiesFor("bridge")).toMatchObject({
      supportsTemplates: false,
      enforcesWindow: false,
      supportsMedia: true,
    });
  });

  it("gives Cloud media and keeps Twilio without it", () => {
    // Cloud uploads bytes to Graph and sends by media id (B1). Twilio would
    // need a public URL for the file, which this seam does not implement, so
    // an attachment there must still be refused rather than dropped.
    expect(capabilitiesFor("cloud").supportsMedia).toBe(true);
    expect(capabilitiesFor("twilio").supportsMedia).toBe(false);
  });

  it("declares media support for every rail, so a new one cannot inherit it", () => {
    // The failure this guards: a fourth rail added with a partial capability
    // record, defaulting to whatever `provider !== "bridge"` used to produce.
    for (const p of ["twilio", "cloud", "bridge"] as const) {
      expect(typeof capabilitiesFor(p).supportsMedia).toBe("boolean");
    }
  });

  it("gives a rail without media no cap and no types, and a rail with media both", () => {
    // The composer builds its file picker from these two fields. A rail that
    // says supportsMedia and offers no types would render a picker that
    // accepts nothing; one that says no media but lists types would leak a
    // picker onto a rail that refuses every upload.
    for (const p of ["twilio", "cloud", "bridge"] as const) {
      const c = capabilitiesFor(p);
      if (c.supportsMedia) {
        expect(c.maxMediaBytes).toBeGreaterThan(0);
        expect(c.mediaMimeTypes.length).toBeGreaterThan(0);
      } else {
        expect(c.maxMediaBytes).toBe(0);
        expect(c.mediaMimeTypes).toEqual([]);
      }
    }
  });
});

describe("bridge capabilities agree with the Go bridge", () => {
  // The bridge's limits live in Go (`decodeMedia` in server.go) and are
  // restated here so the composer can refuse a file BEFORE uploading it. That
  // is a deliberate duplication; this test is what makes it safe. It parses
  // the Go source rather than trusting either copy.
  const goSource = readFileSync(
    join(__dirname, "../../../../services/wa-agent-bridge/api/server.go"),
    "utf8",
  );

  it("maxMediaBytes matches `const maxMediaBytes` in server.go", () => {
    const m = /^const maxMediaBytes = (\d+) << (\d+)$/m.exec(goSource);
    expect(m, "maxMediaBytes not found in server.go — the shape changed").not.toBeNull();
    const goBytes = Number(m![1]) << Number(m![2]);
    expect(capabilitiesFor("bridge").maxMediaBytes).toBe(goBytes);
  });

  it("mediaMimeTypes matches the keys of `allowedMediaMimeTypes` in server.go", () => {
    const block = /var allowedMediaMimeTypes = map\[string\]bool\{([\s\S]*?)\n\}/.exec(goSource);
    expect(block, "allowedMediaMimeTypes not found in server.go").not.toBeNull();
    const goTypes = [...block![1]!.matchAll(/"([^"]+)":\s*true/g)].map((x) => x[1]).sort();
    expect(goTypes.length).toBeGreaterThan(0);
    expect([...capabilitiesFor("bridge").mediaMimeTypes].sort()).toEqual(goTypes);
  });
});
