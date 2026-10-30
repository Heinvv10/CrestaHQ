import { describe, expect, it } from "vitest";
import { computePageSlots } from "@/lib/booking/page-slots";
import type { BookingPage } from "@/types/booking";

/**
 * "Now" late in the day must only bound TODAY: later days offer their slots
 * earlier in the day than now's time of day. Pinned after a CI failure at
 * 21:04Z that looked like this (it was a leaked fixture event, not the walk).
 */

function page(over: Partial<BookingPage>): BookingPage {
  return {
    id: "p",
    slug: "p",
    name: "P",
    description: "",
    status: "published",
    durationMinutes: 30,
    bufferMinutes: 0,
    workingHours: [],
    timezone: "UTC",
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
    agencyId: "a",
    subAccountId: "s",
    createdByUid: "u",
    createdAt: null,
    updatedAt: null,
    ...over,
  };
}
const starts = (p: BookingPage, now: string) =>
  computePageSlots({ page: p, now: new Date(now), busy: [] }).map((s) => s.startAt.toISOString());

describe("now late in the day", () => {
  it("the CI case: Sun 21:04Z, Mon closed by override, Tue opened 21:00–22:00", () => {
    const p = page({
      workingHours: [{ dayOfWeek: 1, startMinute: 1260, endMinute: 1440 }],
      dateOverrides: [
        { date: "2026-09-14", ranges: [] },
        { date: "2026-09-15", ranges: [{ startMinute: 1260, endMinute: 1320 }] },
      ],
    });
    expect(starts(p, "2026-09-13T21:04:00Z")).toEqual([
      "2026-09-15T21:00:00.000Z",
      "2026-09-15T21:30:00.000Z",
    ]);
  });

  it("later days keep slots earlier than now's time of day (weekly hours)", () => {
    const p = page({
      workingHours: [0, 1, 2].map((d) => ({ dayOfWeek: d as 0 | 1 | 2, startMinute: 540, endMinute: 600 })),
    });
    // Sun 23:10Z: Sunday's 09:00 is gone; Monday's and Tuesday's are not.
    expect(starts(p, "2026-09-13T23:10:00Z")).toEqual([
      "2026-09-14T09:00:00.000Z",
      "2026-09-14T09:30:00.000Z",
      "2026-09-15T09:00:00.000Z",
      "2026-09-15T09:30:00.000Z",
    ]);
  });

  it("the same in a non-UTC page timezone (Johannesburg, +2)", () => {
    const p = page({
      timezone: "Africa/Johannesburg",
      workingHours: [1, 2].map((d) => ({ dayOfWeek: d as 1 | 2, startMinute: 540, endMinute: 600 })),
    });
    // 22:30 local on Sunday.
    expect(starts(p, "2026-09-13T20:30:00Z")).toEqual([
      "2026-09-14T07:00:00.000Z",
      "2026-09-14T07:30:00.000Z",
      "2026-09-15T07:00:00.000Z",
      "2026-09-15T07:30:00.000Z",
    ]);
  });

  it("today's earlier slots are still cut by now (min notice 0)", () => {
    const p = page({ workingHours: [{ dayOfWeek: 0, startMinute: 1260, endMinute: 1440 }], visibleDays: 1 });
    expect(starts(p, "2026-09-13T21:04:00Z")).toEqual([
      "2026-09-13T21:30:00.000Z",
      "2026-09-13T22:00:00.000Z",
      "2026-09-13T22:30:00.000Z",
      "2026-09-13T23:00:00.000Z",
      "2026-09-13T23:30:00.000Z",
    ]);
  });
});
