import { describe, expect, it } from "vitest";
import {
  bookOfferKey,
  findMarker,
  parseMarkerAttrs,
  parseStartIso,
  promptSafe,
  rescheduleOfferKey,
  stripBookingMarkers,
} from "@/lib/comms/ai/booking-markers";

describe("stripBookingMarkers", () => {
  it("removes every marker kind", () => {
    const text = 'a [[slots]] b [[book start="x"]] c [[reschedule booking="b1" start="y"]] d [[ Cancel booking="b1"]] e';
    expect(stripBookingMarkers(text)).toBe("a b c d e");
  });

  it("brackets that only look like a marker are prose", () => {
    for (const prose of ["[[Book now]] and save", "[[booking]]", '[[book-x start="x"]]', "Our [[cancel policy is strict"]) {
      expect(stripBookingMarkers(prose)).toBe(prose);
    }
  });

  it("a marker formed by stripping a nested one goes too", () => {
    expect(stripBookingMarkers('a [[bo[[book start="x"]]ok start="y"]] b')).toBe("a b");
  });

  it("an empty marker inside a non-marker span goes; the prose stays", () => {
    expect(stripBookingMarkers("[[book now [[slots ]] x")).toBe("[[book now x");
  });

  it("drops a fence the strip left empty, and only then", () => {
    expect(stripBookingMarkers('Here:\n```\n[[book start="x"]]\n```\nThanks')).toBe("Here:\nThanks");
    expect(stripBookingMarkers("```\n```")).toBe("```\n```");
    expect(stripBookingMarkers('```js\ncode()\n```\n[[slots]]')).toBe("```js\ncode()\n```\n");
  });

  it("drops a trailing unclosed marker and everything after it", () => {
    expect(stripBookingMarkers('See you then! [[book start="2026-11-03T08:00:00Z" name="Ann"')).toBe("See you then! ");
    expect(stripBookingMarkers("ok [[slots]] then [[cancel")).toBe("ok then [[cancel");
    expect(stripBookingMarkers('Our [[cancel policy is strict. [[book start="2026-')).toBe("Our [[cancel policy is strict. ");
  });

  it("leaves other brackets alone", () => {
    expect(stripBookingMarkers("[[form]] and [link] and [[bookmark]]")).toBe("[[form]] and [link] and [[bookmark]]");
  });

  it("is linear: a huge reply of unclosed markers strips fast", () => {
    const adversarial = "[[book ".repeat(60_000) + "]]x" + '[[slots a="'.repeat(60_000);
    const t0 = performance.now();
    const out = stripBookingMarkers(adversarial);
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(out).toBe(`${"[[book ".repeat(59_999)}x`);
  });
});

describe("findMarker", () => {
  it("whole only when the trimmed text is the marker", () => {
    expect(findMarker(' [[book start="x"]]\n', "book")).toEqual({ attrs: ' start="x"', whole: true });
    expect(findMarker('ok [[book start="x"]]', "book")?.whole).toBe(false);
    expect(findMarker('[[book a="1"]][[book a="2"]]', "book")?.whole).toBe(false);
    expect(findMarker("[[booking]]", "book")).toBeNull();
    expect(findMarker('[[book-x start="x"]]', "book")).toBeNull();
    expect(findMarker("[[Book now]]", "book")).toBeNull();
    expect(findMarker('[[book now]] [[book start="x"]]', "book")).toEqual({ attrs: ' start="x"', whole: false });
  });

  it("whole is judged on the full reply, past the scan cap too", () => {
    const marker = '[[book start="x"]]';
    expect(findMarker(`${marker}${" ".repeat(16_001)}and some prose`, "book")?.whole).toBe(false);
    expect(findMarker(`${marker}${" ".repeat(16_001)}`, "book")?.whole).toBe(true);
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
  it("strict ISO with an explicit offset, as the canonical instant", () => {
    expect(parseStartIso("2026-11-03T10:00:00+02:00")).toBe("2026-11-03T08:00:00.000Z");
    expect(parseStartIso("2026-11-03T03:30-04:30")).toBe("2026-11-03T08:00:00.000Z");
    expect(parseStartIso("2026-11-03T08:00:00.5Z")).toBe("2026-11-03T08:00:00.500Z");
  });

  it.each([
    "",
    "tuesday",
    "2026-11-03T08:00:00",
    "2026-11-03",
    "Tue, 03 Nov 2026 08:00:00 GMT",
    "2026-02-30T08:00:00Z",
    "2026-11-03T24:00:00Z",
    "2026-11-03T08:60:00Z",
    "2026-11-03T08:00:60Z",
    "2026-11-03T08:00:00+15:00",
    "2026-11-03T08:00:00+02:60",
    "2026-11-03 08:00:00Z",
  ])("rejects %j", (raw) => {
    expect(parseStartIso(raw)).toBeNull();
  });
});

describe("promptSafe", () => {
  it("drops quotes, brackets, control characters and Unicode line breaks", () => {
    expect(promptSafe('a"b[c]d\u2028e\u2029f\u0085g\nh\u0007i')).toBe("abcdefghi");
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
