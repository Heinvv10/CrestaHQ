import { describe, expect, it } from "vitest";
import { computeAvailability, utcFromWallClock } from "@/lib/booking/availability";
import type { BookingPage } from "@/types/booking";

/**
 * The day walk must visit LOCAL calendar dates for every UTC offset. It
 * used to anchor each day at noon UTC, which for UTC+12..+14 is already the
 * next local date: today was skipped, and a book-time re-verify (window =
 * slot ± 1 ms) walked the wrong date and found nothing, so every booking on
 * such a page was refused.
 *
 * Expected instants here come from utcFromWallClock (a round trip);
 * availability.dst.test.ts pins DST days against hand-written instants.
 */

function page(timezone: string): BookingPage {
  return {
    id: "p",
    slug: "p",
    name: "P",
    description: "",
    status: "published",
    durationMinutes: 30,
    bufferMinutes: 0,
    // Every day, 09:00–10:00 local.
    workingHours: [0, 1, 2, 3, 4, 5, 6].map((d) => ({
      dayOfWeek: d as 0 | 1 | 2 | 3 | 4 | 5 | 6,
      startMinute: 540,
      endMinute: 600,
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

const local = (tz: string, y: number, m: number, d: number, hhmm: string) =>
  utcFromWallClock(y, m, d, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)), tz);

const ZONES = [
  "Pacific/Auckland", // +12
  "Pacific/Tongatapu", // +13
  "Pacific/Kiritimati", // +14
  "Pacific/Pago_Pago", // −11
  "America/New_York",
  "Africa/Johannesburg",
];

describe.each(ZONES)("%s", (tz) => {
  const p = page(tz);
  // 06:00 local on 2026-09-14 — before today's 09:00 opening.
  const now = local(tz, 2026, 9, 14, "06:00");

  it("lists today's local slots first", () => {
    const slots = computeAvailability({ page: p, now, busy: [] });
    expect(slots[0].startAt.toISOString()).toBe(local(tz, 2026, 9, 14, "09:00").toISOString());
    expect(slots[1].startAt.toISOString()).toBe(local(tz, 2026, 9, 14, "09:30").toISOString());
  });

  it("re-verifies a single slot (window = slot ± 1 ms), today and tomorrow", () => {
    for (const day of [14, 15]) {
      const start = local(tz, 2026, 9, day, "09:30");
      const end = new Date(start.getTime() + 30 * 60_000);
      const slots = computeAvailability({
        page: p,
        now,
        busy: [],
        fromInstant: new Date(start.getTime() - 1),
        toInstant: new Date(end.getTime() + 1),
      });
      expect(slots.map((s) => s.startAt.toISOString())).toEqual([start.toISOString()]);
    }
  });
});

describe("DST change days (round trip through utcFromWallClock)", () => {
  it.each([
    ["Pacific/Auckland", 2026, 9, 27], // NZDT starts 02:00 → 03:00
    ["Pacific/Auckland", 2026, 4, 5], // NZST resumes 03:00 → 02:00
    ["America/New_York", 2026, 3, 8],
    ["Europe/London", 2026, 10, 25],
  ] as const)("%s %i-%i-%i: 09:30 local is listed and re-verifies", (tz, y, m, d) => {
    const p = page(tz);
    const now = local(tz, y, m, d, "01:00");
    const start = local(tz, y, m, d, "09:30");
    const listed = computeAvailability({ page: p, now, busy: [] });
    expect(listed.map((s) => s.startAt.toISOString())).toContain(start.toISOString());
    const reverify = computeAvailability({
      page: p,
      now,
      busy: [],
      fromInstant: new Date(start.getTime() - 1),
      toInstant: new Date(start.getTime() + 30 * 60_000 + 1),
    });
    expect(reverify).toHaveLength(1);
  });
});
