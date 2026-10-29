import { describe, expect, it } from "vitest";
import {
  bookOfferKey,
  findMarker,
  parseMarkerAttrs,
  parseStartIso,
  rescheduleOfferKey,
  stripBookingMarkers,
} from "@/lib/comms/ai/booking-markers";

describe("stripBookingMarkers", () => {
  it("removes every marker kind", () => {
    const text = 'a [[slots]] b [[book start="x"]] c [[reschedule booking="b1" start="y"]] d [[ Cancel booking="b1"]] e';
    expect(stripBookingMarkers(text)).toBe("a  b  c  d  e");
  });

  it("drops a trailing unclosed marker and everything after it", () => {
    expect(stripBookingMarkers('See you then! [[book start="2026-11-03T08:00:00Z" name="Ann"')).toBe("See you then! ");
    expect(stripBookingMarkers("ok [[slots]] then [[cancel")).toBe("ok  then ");
  });

  it("leaves other brackets alone", () => {
    expect(stripBookingMarkers("[[form]] and [link] and [[bookmark]]")).toBe("[[form]] and [link] and [[bookmark]]");
  });

  it("is linear: a huge reply of unclosed markers strips fast", () => {
    const adversarial = "[[book ".repeat(60_000) + "]]x".repeat(1) + "[[slots ".repeat(60_000);
    const t0 = performance.now();
    const out = stripBookingMarkers(adversarial);
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(out).toBe("x");
  });
});

describe("findMarker", () => {
  it("whole only when the trimmed text is the marker", () => {
    expect(findMarker(' [[book start="x"]]\n', "book")).toEqual({ attrs: ' start="x"', whole: true });
    expect(findMarker('ok [[book start="x"]]', "book")?.whole).toBe(false);
    expect(findMarker('[[book a="1"]][[book a="2"]]', "book")?.whole).toBe(false);
    expect(findMarker("[[booking]]", "book")).toBeNull();
  });
});

describe("parseMarkerAttrs", () => {
  it("reads key=value pairs, keys case-insensitive", () => {
    expect(Object.fromEntries(parseMarkerAttrs(' Start="x" name = " Ann "')!)).toEqual({ start: "x", name: "Ann" });
  });

  it("a repeated key is null", () => {
    expect(parseMarkerAttrs(' start="x" START="y"')).toBeNull();
  });
});

describe("parseStartIso", () => {
  it("canonical instant, or null for no date", () => {
    expect(parseStartIso("2026-11-03T10:00:00+02:00")).toBe("2026-11-03T08:00:00.000Z");
    expect(parseStartIso("tuesday")).toBeNull();
    expect(parseStartIso("")).toBeNull();
  });
});

describe("offer keys", () => {
  it("separate book from move, and one host from another and from pooled", () => {
    const iso = "2026-11-03T08:00:00.000Z";
    const keys = new Set([
      bookOfferKey("p", null, iso),
      bookOfferKey("p", "u1", iso),
      bookOfferKey("p", "u2", iso),
      rescheduleOfferKey("p", iso),
    ]);
    expect(keys.size).toBe(4);
    expect(bookOfferKey("p", "u1", "2026-11-03T10:00:00+02:00")).toBe(bookOfferKey("p", "u1", iso));
  });
});
