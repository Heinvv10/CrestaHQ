import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { resolveWhatsAppProviderId, capabilitiesFor } from "./provider";
import { mediaKindForMime } from "@/types/whatsapp-media";

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
        // Every kind the rail lists a type for has a cap to check it against.
        for (const t of c.mediaMimeTypes) {
          expect(c.maxMediaBytes[mediaKindForMime(t)]).toBeGreaterThan(0);
        }
        expect(c.mediaMimeTypes.length).toBeGreaterThan(0);
      } else {
        expect(Object.values(c.maxMediaBytes).every((n) => n === 0)).toBe(true);
        expect(c.maxMediaCaptionChars).toBe(0);
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

  it("maxMediaBytes matches `const maxMediaBytes` in server.go for every kind", () => {
    // The Go bridge has ONE cap for all kinds; the per-kind shape here must
    // restate that same number under every key.
    const m = /^const maxMediaBytes = (\d+) << (\d+)$/m.exec(goSource);
    expect(m, "maxMediaBytes not found in server.go — the shape changed").not.toBeNull();
    const goBytes = Number(m![1]) << Number(m![2]);
    const caps = capabilitiesFor("bridge").maxMediaBytes;
    expect(Object.keys(caps).sort()).toEqual(["audio", "document", "image", "sticker", "video"]);
    for (const v of Object.values(caps)) expect(v).toBe(goBytes);
  });

  it("offers no audio and only video/mp4 on Cloud, and caps captions at 1024", () => {
    const c = capabilitiesFor("cloud");
    expect(c.mediaMimeTypes.some((t) => t.startsWith("audio/"))).toBe(false);
    // The only video type is the one the send route inspects codecs for.
    expect(c.mediaMimeTypes.filter((t) => t.startsWith("video/"))).toEqual(["video/mp4"]);
    expect(c.maxMediaCaptionChars).toBe(1024);
  });

  it("the bridge caption cap matches `const maxTextRunes` in server.go", () => {
    // The caption IS the bridge's Text, so it is bounded by the same constant.
    const m = /^const maxTextRunes = (\d+)$/m.exec(goSource);
    expect(m, "maxTextRunes not found in server.go").not.toBeNull();
    expect(capabilitiesFor("bridge").maxMediaCaptionChars).toBe(Number(m![1]));
  });

  it("caps Cloud images at Meta's 5 MB, below the 16 MiB the other kinds get", () => {
    const caps = capabilitiesFor("cloud").maxMediaBytes;
    // Decimal, as Meta states it — not 5 MiB.
    expect(caps.image).toBe(5_000_000);
    expect(caps.video).toBe(16 << 20);
    expect(caps.document).toBe(16 << 20);
  });

  it("mediaMimeTypes matches the keys of `allowedMediaMimeTypes` in server.go", () => {
    const block = /var allowedMediaMimeTypes = map\[string\]bool\{([\s\S]*?)\n\}/.exec(goSource);
    expect(block, "allowedMediaMimeTypes not found in server.go").not.toBeNull();
    const goTypes = [...block![1]!.matchAll(/"([^"]+)":\s*true/g)].map((x) => x[1]).sort();
    expect(goTypes.length).toBeGreaterThan(0);
    expect([...capabilitiesFor("bridge").mediaMimeTypes].sort()).toEqual(goTypes);
  });
});
