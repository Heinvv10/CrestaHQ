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

  it("strips sloppy-quoted markers (never shown); the executor still won't run them", () => {
    expect(stripBookingMarkers("Sure! [[slots host=Jane]] One moment.")).toBe("Sure! One moment.");
    expect(stripBookingMarkers("ok [[book start='2026-11-03T08:00:00Z' name='Ann']] done")).toBe("ok done");
    expect(stripBookingMarkers("ok [[book name=\u201cAnn\u201d]] done")).toBe("ok done");
    expect(findMarker("[[slots host=Jane]]", "slots")).toBeNull();
    expect(findMarker("[[book name=\u201cAnn\u201d]]", "book")).toBeNull();
  });

  it("a zero-width character or whitespace after [[ doesn't hide a marker", () => {
    expect(stripBookingMarkers('a [[\u200Bbook start="x"]] b')).toBe("a b");
    expect(stripBookingMarkers("a [[\uFEFF \u2060slots]] b")).toBe("a b");
  });

  it('a "]]" inside a value, and a stray "]]" after a marker, go with it', () => {
    expect(stripBookingMarkers('Done [[book name="a]]b" start="x"]] thanks')).toBe("Done thanks");
    expect(stripBookingMarkers("ok [[slots]]]] next")).toBe("ok next");
    expect(stripBookingMarkers("ok [[slots]]\nline ]] two")).toBe("ok \nline ]] two");
  });

  it("an opener cut off at max tokens goes to the end", () => {
    expect(stripBookingMarkers("Hi [[book start=")).toBe("Hi ");
    expect(stripBookingMarkers("Hi [[")).toBe("Hi ");
    expect(stripBookingMarkers("Hi [[resch")).toBe("Hi ");
    expect(stripBookingMarkers("Hi [[bo[[sl")).toBe("Hi ");
    expect(stripBookingMarkers('See you then! [[book start="2026-11-03T08:00:00Z" name="Ann"')).toBe("See you then! ");
  });

  it("inner openers go with the marker", () => {
    expect(stripBookingMarkers("x [[book [[slots]] y")).toBe("x y");
    expect(stripBookingMarkers('x [[book a="[[cancel b=1]]" c]] y')).toBe("x y");
    // One pass: removing the inner marker can't form a new one, because the
    // rest of the outer span ends at an orphan "]]" and goes too.
    const spliced = stripBookingMarkers('a [[bo[[book start="x"]]ok start="y"]] b');
    expect(spliced).toBe("a [[bo b");
    expect(stripBookingMarkers(spliced)).toBe(spliced);
  });

  // Accepted trade-off: prose that starts like a marker is stripped too.
  it("prose that starts like a marker is stripped; other brackets are not", () => {
    expect(stripBookingMarkers("[[Book now]] and save")).toBe(" and save");
    expect(stripBookingMarkers("Our [[cancel policy is strict")).toBe("Our ");
    expect(stripBookingMarkers('a [[book-x start="x"]] b')).toBe("a b");
    expect(stripBookingMarkers("[[form]] and [link] and [[bookmark]] and [[booking]]")).toBe(
      "[[form]] and [link] and [[bookmark]] and [[booking]]",
    );
  });

  it("repeats while removing one marker exposes another", () => {
    const a = stripBookingMarkers("a [[bo[[slots]]ok x");
    expect(a).toBe("a ");
    const b = stripBookingMarkers("x [[[[slots]]book now");
    expect(b).toBe("x ");
    for (const out of [a, b]) expect(stripBookingMarkers(out)).toBe(out);
    // A second pass keeps the prose after the exposed marker; cutting wouldn't.
    expect(stripBookingMarkers("a [[bo[[slots]]ok\n]] keep this")).toBe("a keep this");
  });

  it("after 3 passes, everything from the first remaining opener goes", () => {
    // Each level needs one more pass: "[[bo" + inner + "ok\n]]".
    let nested = "[[slots]]";
    for (let i = 0; i < 5; i++) nested = `[[bo${nested}ok\n]]`;
    const out = stripBookingMarkers(`Hi ${nested}`);
    // The cut leaves "[[bo[[bo" at the end, which reads as cut-off openers.
    expect(out).toBe("Hi ");
    expect(stripBookingMarkers(out)).toBe(out);
  });

  it.each([
    ["soft hyphen", "\u00AD"],
    ["combining grapheme joiner", "\u034F"],
    ["Mongolian vowel separator", "\u180E"],
    ["braille blank", "\u2800"],
    ["NEL", "\u0085"],
    ["Hangul filler", "\u3164"],
    ["Hangul choseong filler", "\u115F"],
    ["halfwidth Hangul filler", "\uFFA0"],
    ["format character (LRI)", "\u2066"],
  ])("an invisible %s after [[ doesn't hide an opener", (_name, ch) => {
    expect(stripBookingMarkers(`a [[${ch}book start="x"]] b`)).toBe("a b");
    expect(stripBookingMarkers(`Hi [[${ch}`)).toBe("Hi ");
  });

  it("a Hangul filler right after the keyword doesn't hide an opener", () => {
    for (const ch of ["\u3164", "\u115F", "\uFFA0"]) {
      expect(stripBookingMarkers(`a [[book${ch}start=x]] b`)).toBe("a b");
    }
    expect(stripBookingMarkers("[[bookmark]] [[bookings]]")).toBe("[[bookmark]] [[bookings]]");
  });

  it("drops a fence the strip left empty, and only then", () => {
    expect(stripBookingMarkers('Here:\n```\n[[book start="x"]]\n```\nThanks')).toBe("Here:\nThanks");
    expect(stripBookingMarkers("```\n```")).toBe("```\n```");
    expect(stripBookingMarkers("```js\ncode()\n```\n[[slots]]")).toBe("```js\ncode()\n```\n");
  });

  it("is linear on 2M chars of markers", () => {
    const text = "[[slots]] x ".repeat(Math.ceil(2_000_000 / 12));
    const t0 = performance.now();
    const out = stripBookingMarkers(text);
    expect(performance.now() - t0).toBeLessThan(2_000);
    expect(out).not.toContain("[[");
    expect(out).not.toContain("  ");
  });

  it("is linear on unclosed openers", () => {
    const text = "[[book ".repeat(60_000) + "]]x" + '[[slots a="'.repeat(60_000);
    const t0 = performance.now();
    expect(stripBookingMarkers(text)).toBe("x");
    expect(performance.now() - t0).toBeLessThan(2_000);
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
