import { describe, expect, it } from "vitest";
import { generateIcs } from "./ics";
import { generateIcsFeed } from "./ics-feed";
import { eventLocationText } from "./location";

/**
 * A booker's text reaches an invite's LOCATION / SUMMARY / CN. A raw CR or
 * LF in it would end that content line and let the rest be read as a
 * property of the booker's choosing (a second ATTENDEE, a new METHOD).
 */

const INJECT = [
  ["CRLF", "+27 60\r\nATTENDEE:mailto:evil@example.com"],
  ["a lone CR", "+27 60\rATTENDEE:mailto:evil@example.com"],
  ["a lone LF", "+27 60\nATTENDEE:mailto:evil@example.com"],
  ["a vertical tab and NUL", "+27 60\u000b\u0000ATTENDEE:mailto:evil@example.com"],
  ["a Unicode line separator", "+27 60\u2028ATTENDEE:mailto:evil@example.com"],
  ["a Unicode paragraph separator", "+27 60\u2029ATTENDEE:mailto:evil@example.com"],
  ["NEL", "+27 60\u0085ATTENDEE:mailto:evil@example.com"],
] as const;
/** Anything a reader might take as a line break or control, bar the CRLF line endings. */
const BREAKING = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

const BASE = {
  uid: "e1",
  domain: "app.test",
  startAt: new Date("2026-10-01T10:00:00Z"),
  endAt: new Date("2026-10-01T10:30:00Z"),
  summary: "Intro",
  attendeeEmail: "v@example.com",
};

/** Unfold (RFC 5545 §3.1), then the property names, one per content line. */
const properties = (ics: string) =>
  ics.replace(/\r\n /g, "").split("\r\n").filter(Boolean).map((l) => /^[A-Z-]+/.exec(l)?.[0]);

describe.each(INJECT)("text with %s", (_label, text) => {
  it("stays inside its own property in an invite", () => {
    const ics = generateIcs({ ...BASE, location: text, attendeeName: text, description: text });
    expect(ics).not.toMatch(/[\r\n]ATTENDEE:/);
    expect(properties(ics).filter((p) => p === "ATTENDEE")).toHaveLength(1);
    // Every byte that is not the CRLF line ending is printable.
    expect(ics.replace(/\r\n/g, "")).not.toMatch(BREAKING);
  });

  it("stays inside its own property in the subscription feed", () => {
    const feed = generateIcsFeed({
      domain: "app.test",
      calendarName: text,
      events: [{ uid: "e1", startAt: BASE.startAt, endAt: BASE.endAt, summary: text, location: text, status: "CONFIRMED" }],
    });
    expect(feed).not.toMatch(/[\r\n]ATTENDEE:/);
    expect(feed.replace(/\r\n/g, "")).not.toMatch(BREAKING);
  });

  it("is never used as the booker's phone or address in the location text", () => {
    expect(eventLocationText({ type: "we_call", value: null }, { phone: text })).toBe("Phone call: we'll call you");
    expect(eventLocationText({ type: "their_address", value: null }, { address: text })).toBe("At your address");
  });
});

it("a line break in plain text still reads as one in the invite (escaped \\n)", () => {
  expect(generateIcs({ ...BASE, description: "a\r\nb\rc\nd" })).toContain("DESCRIPTION:a\\nb\\nc\\nd");
});

it("the same in the subscription feed", () => {
  const feed = generateIcsFeed({
    domain: "app.test",
    calendarName: "Cal",
    events: [{ uid: "e1", startAt: BASE.startAt, endAt: BASE.endAt, summary: "S", description: "a\r\nb\rc\nd", status: "CONFIRMED" }],
  });
  expect(feed).toContain("DESCRIPTION:a\\nb\\nc\\nd");
});

describe("a name in CN=", () => {
  /** The property's value: everything after the first ':' outside quotes. */
  const valueOf = (line: string) => {
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') quoted = !quoted;
      else if (line[i] === ":" && !quoted) return line.slice(i + 1);
    }
    return null;
  };
  const line = (ics: string, name: string) =>
    ics.replace(/\r\n /g, "").split("\r\n").find((l) => l.startsWith(name)) ?? "";

  it.each([
    ["a colon", "Ann:mailto:evil@example.com"],
    ["a quote", 'Ann";ROLE=CHAIR:mailto:evil@example.com'],
    ["a semicolon", "Ann;RSVP=FALSE"],
  ])("with %s can't change the attendee's or organizer's address", (_l, name) => {
    const ics = generateIcs({ ...BASE, attendeeName: name, organizerEmail: "o@example.com", organizerName: name });
    const attendee = line(ics, "ATTENDEE");
    const organizer = line(ics, "ORGANIZER");
    expect(valueOf(attendee)).toBe("mailto:v@example.com");
    expect(valueOf(organizer)).toBe("mailto:o@example.com");
    expect(attendee).toMatch(/^ATTENDEE;CN="[^"]*";RSVP=TRUE;PARTSTAT=NEEDS-ACTION:mailto:v@example\.com$/);
  });

  it("keeps an ordinary name readable, quoted, without TEXT escapes", () => {
    const ics = generateIcs({ ...BASE, attendeeName: "O'Brien, Ann" });
    expect(line(ics, "ATTENDEE")).toContain('CN="O\'Brien, Ann";');
  });
});

describe("an email address in mailto:", () => {
  it.each([
    ["CRLF", "v@example.com\r\nATTENDEE:mailto:evil@example.com"],
    ["a line separator", "v@example.com\u2028ATTENDEE:mailto:evil@example.com"],
    ["NEL", "v@example.com\u0085ATTENDEE:mailto:evil@example.com"],
    ["a space and a tab", "v@example.com ;ROLE=CHAIR\tx"],
  ])("with %s stays one value on its own line", (_l, email) => {
    const ics = generateIcs({ ...BASE, attendeeEmail: email, organizerEmail: email });
    expect(properties(ics).filter((p) => p === "ATTENDEE")).toHaveLength(1);
    expect(ics.replace(/\r\n/g, "")).not.toMatch(BREAKING);
    const attendee = ics.replace(/\r\n /g, "").split("\r\n").find((l) => l.startsWith("ATTENDEE"))!;
    expect(attendee).not.toMatch(/mailto:\S*\s/);
  });
});

describe("folding long lines", () => {
  const octets = (l: string) => new TextEncoder().encode(l).length;
  const unfold = (ics: string) => ics.replace(/\r\n /g, "");

  it.each([
    ["CJK", "予約の確認：東京本社で打ち合わせ。".repeat(12)],
    ["emoji (surrogate pairs)", "Meeting 📅🤝 ".repeat(20)],
    ["mixed", `Ünïcödé café — ${"数".repeat(40)} ${"🙂".repeat(30)}`],
  ])("%s: every line is at most 75 octets and no character is split", (_l, summary) => {
    for (const ics of [
      generateIcs({ ...BASE, summary }),
      generateIcsFeed({ domain: "app.test", calendarName: "Cal", events: [{ uid: "e1", startAt: BASE.startAt, endAt: BASE.endAt, summary, status: "CONFIRMED" }] }),
    ]) {
      const lines = ics.split("\r\n").filter(Boolean);
      expect(lines.filter((l) => octets(l) > 75)).toEqual([]);
      // A split surrogate pair or code point would not survive the round trip.
      expect(ics).not.toMatch(/\uFFFD|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
      expect(unfold(ics)).toContain(`SUMMARY:${summary}`);
    }
  });

  it("a short ASCII line is not folded", () => {
    expect(generateIcs({ ...BASE, summary: "Intro" })).toContain("\r\nSUMMARY:Intro\r\n");
  });
});
