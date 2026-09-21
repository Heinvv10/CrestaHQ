import { describe, expect, it } from "vitest";
import { locationPreviewLabel, parseWhatsappLocation } from "./whatsapp-location";

describe("parseWhatsappLocation", () => {
  it.each([
    [90, 180],
    [-90, -180],
    [90, -180],
    [-90, 180],
  ])("accepts the boundary (%d, %d)", (latitude, longitude) => {
    expect(parseWhatsappLocation({ latitude, longitude })).toEqual({ latitude, longitude });
  });

  it.each([
    [90.0000001, 0],
    [-90.0000001, 0],
    [0, 180.0000001],
    [0, -180.0000001],
  ])("refuses (%d, %d), a hair past the boundary", (latitude, longitude) => {
    expect(parseWhatsappLocation({ latitude, longitude })).toBeNull();
  });

  it("removes zero-width, bidi and BOM characters from the customer's strings", () => {
    const loc = parseWhatsappLocation({
      latitude: -26.3,
      longitude: 27.8,
      name: "\u202eesuoh\u202c \u200bThandi\u2066\ufeff",
      address: "12\u200d Main\u200f Rd\u2069",
    });
    expect(loc).toEqual({
      latitude: -26.3,
      longitude: 27.8,
      name: "esuoh Thandi",
      address: "12 Main Rd",
    });
  });

  it("drops a name made only of invisible characters, so the label falls back", () => {
    const loc = parseWhatsappLocation({
      latitude: -26.3,
      longitude: 27.8,
      name: "\u200b\u200c\u200d\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\ufeff",
    });
    expect(loc).not.toBeNull();
    expect(loc && "name" in loc).toBe(false);
    expect(locationPreviewLabel(loc!)).toBe("📍 Location");
  });
});
