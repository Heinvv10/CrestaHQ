import { describe, expect, it } from "vitest";
import { computeAvailability, formatterFor } from "@/lib/booking/availability";
import type { BookingPage } from "@/types/booking";

/**
 * DST around the day walk, with expected instants written out by hand (no
 * library round-trip as the oracle). A one-pass wall→UTC conversion takes
 * the offset at the wall-as-UTC guess, which is on the other side of the
 * transition for days next to it: slots duplicated, missing, or outside the
 * hours. Rules: a wall time inside a spring-forward gap does not exist and
 * is skipped; a repeated (fall-back) wall time uses its first occurrence;
 * a slot is its duration in real time and must end inside the range in
 * wall time.
 */

const HALF_HOUR = 30 * 60_000;

function page(timezone: string, startMinute = 540, endMinute = 1020): BookingPage {
  return {
    id: "p",
    slug: "p",
    name: "P",
    description: "",
    status: "published",
    durationMinutes: 30,
    bufferMinutes: 0,
    workingHours: [0, 1, 2, 3, 4, 5, 6].map((d) => ({
      dayOfWeek: d as 0 | 1 | 2 | 3 | 4 | 5 | 6,
      startMinute,
      endMinute,
    })),
    timezone,
    visibleDays: 3,
    minNoticeHours: 0,
    maxPerDay: null,
    intakeFields: [],
    logoUrl: null,
    accentColor: null,
    confirmationMessage: "",
    remindersEnabled: false,
    reminderOffsetsMinutes: [],
    payment: null,
    territoryId: "global",
    defaultTerritoryId: null,
    agencyId: "ag",
    subAccountId: "sa",
    createdByUid: "u",
    createdAt: null,
    updatedAt: null,
  };
}

/** Slots whose start falls in [from, to), as ISO strings. */
function listed(p: BookingPage, from: string, to: string): string[] {
  const f = new Date(from).getTime();
  const t = new Date(to).getTime();
  return computeAvailability({ page: p, now: new Date(f - 12 * 3600_000), busy: [] })
    .filter((s) => s.startAt.getTime() >= f && s.startAt.getTime() < t)
    .map((s) => s.startAt.toISOString());
}

function reverifies(p: BookingPage, startIso: string): boolean {
  const start = new Date(startIso);
  const slots = computeAvailability({
    page: p,
    now: new Date(start.getTime() - 12 * 3600_000),
    busy: [],
    fromInstant: new Date(start.getTime() - 1),
    toInstant: new Date(start.getTime() + HALF_HOUR + 1),
  });
  return slots.length === 1 && slots[0].startAt.toISOString() === startIso;
}

const every30 = (firstIso: string, n: number) =>
  Array.from({ length: n }, (_, i) => new Date(new Date(firstIso).getTime() + i * HALF_HOUR).toISOString());

describe("09:00–17:00 on days next to a DST change: 16 slots at the right instants", () => {
  it.each([
    // tz, local date, 09:00 local in UTC
    ["Pacific/Auckland", "2026-09-26", "2026-09-25T21:00:00.000Z"], // DST eve, NZST +12
    ["Pacific/Auckland", "2026-04-05", "2026-04-04T21:00:00.000Z"], // fall-back day, after 03:00 → NZST
    ["Australia/Sydney", "2026-10-03", "2026-10-02T23:00:00.000Z"], // eve, AEST +10
    ["Australia/Sydney", "2026-04-04", "2026-04-03T22:00:00.000Z"], // eve, AEDT +11
    ["Australia/Adelaide", "2026-10-03", "2026-10-02T23:30:00.000Z"], // +9:30
    ["Australia/Adelaide", "2026-04-04", "2026-04-03T22:30:00.000Z"], // +10:30
    ["Pacific/Chatham", "2026-09-26", "2026-09-25T20:15:00.000Z"], // +12:45
    ["Pacific/Chatham", "2026-04-04", "2026-04-03T19:15:00.000Z"], // +13:45
    ["Australia/Lord_Howe", "2026-10-03", "2026-10-02T22:30:00.000Z"], // +10:30
    ["Australia/Lord_Howe", "2026-04-04", "2026-04-03T22:00:00.000Z"], // +11
    ["America/Los_Angeles", "2026-03-07", "2026-03-07T17:00:00.000Z"], // eve, PST
    ["America/Los_Angeles", "2026-03-08", "2026-03-08T16:00:00.000Z"], // change day, PDT from 02:00
    ["America/New_York", "2026-03-07", "2026-03-07T14:00:00.000Z"], // eve, EST
    ["America/New_York", "2026-03-08", "2026-03-08T13:00:00.000Z"], // change day, EDT
  ])("%s %s", (tz, _date, firstIso) => {
    const p = page(tz);
    const expected = every30(firstIso, 16);
    const lastEnd = new Date(new Date(firstIso).getTime() + 8 * 3600_000).toISOString();
    expect(listed(p, firstIso, lastEnd)).toEqual(expected);
    // Nothing just before 09:00 or from 17:00 local either.
    const before = new Date(new Date(firstIso).getTime() - HALF_HOUR).toISOString();
    expect(listed(p, before, firstIso)).toEqual([]);
    expect(listed(p, lastEnd, new Date(new Date(lastEnd).getTime() + HALF_HOUR).toISOString())).toEqual([]);
    for (const s of expected) expect(reverifies(p, s)).toBe(true);
  });
});

describe("New York transition hours", () => {
  it("a range starting in the spring-forward gap (02:30–04:00) skips 02:30 and never runs past 04:00", () => {
    const p = page("America/New_York", 150, 240);
    // 03:00 and 03:30 EDT.
    expect(listed(p, "2026-03-08T05:00:00Z", "2026-03-08T12:00:00Z")).toEqual([
      "2026-03-08T07:00:00.000Z",
      "2026-03-08T07:30:00.000Z",
    ]);
  });

  it("a slot ending past the range in wall time is dropped (01:00–02:30 on spring-forward day)", () => {
    const p = page("America/New_York", 60, 150);
    // 01:30 EST + 30 min real = 03:00 EDT, past 02:30.
    expect(listed(p, "2026-03-08T05:00:00Z", "2026-03-08T12:00:00Z")).toEqual([
      "2026-03-08T06:00:00.000Z",
    ]);
  });

  it("fall-back (01:00–03:00): 01:00/01:30 at their first occurrence, and 02:00/02:30 kept", () => {
    const p = page("America/New_York", 60, 180);
    const slots = listed(p, "2026-11-01T04:00:00Z", "2026-11-01T09:00:00Z");
    expect(slots).toEqual([
      "2026-11-01T05:00:00.000Z", // 01:00 EDT
      "2026-11-01T05:30:00.000Z", // 01:30 EDT
      "2026-11-01T07:00:00.000Z", // 02:00 EST
      "2026-11-01T07:30:00.000Z", // 02:30 EST
    ]);
    for (const s of slots) expect(reverifies(p, s)).toBe(true);
  });
});

describe("24-hour pages", () => {
  it.each([
    ["Pacific/Auckland", "2026-09-26T11:00:00.000Z"], // 23:00 NZST on DST eve
    ["Australia/Sydney", "2026-10-03T13:00:00.000Z"], // 23:00 AEST on DST eve
  ])("%s: the eve's 23:00 slot is listed and re-verifies", (tz, iso) => {
    const p = page(tz, 0, 1440);
    expect(listed(p, iso, new Date(new Date(iso).getTime() + 1).toISOString())).toEqual([iso]);
    expect(reverifies(p, iso)).toBe(true);
  });

  it("New York spring-forward day: 46 slots (02:00/02:30 don't exist), none duplicated", () => {
    const p = page("America/New_York", 0, 1440);
    const day = listed(p, "2026-03-08T05:00:00Z", "2026-03-09T04:00:00Z");
    expect(day).toHaveLength(46);
    expect(new Set(day).size).toBe(46);
    expect(day).toContain("2026-03-08T06:30:00.000Z"); // 01:30 EST
    expect(day).toContain("2026-03-08T07:00:00.000Z"); // 03:00 EDT
  });

  it("New York fall-back day: 48 slots, none duplicated", () => {
    const p = page("America/New_York", 0, 1440);
    const day = listed(p, "2026-11-01T04:00:00Z", "2026-11-02T05:00:00Z");
    expect(day).toHaveLength(48);
    expect(new Set(day).size).toBe(48);
  });
});

describe("timezone formatter cache", () => {
  it("spellings of one zone share one formatter", () => {
    expect(formatterFor("europe/london")).toBe(formatterFor("Europe/London"));
    expect(formatterFor("EUROPE/LONDON").resolvedOptions().timeZone).toBe("Europe/London");
  });
});
