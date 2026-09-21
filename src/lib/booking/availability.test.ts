import { describe, expect, it } from "vitest";
import { computeAvailability } from "@/lib/booking/availability";
import type { BookingPage } from "@/types/booking";

/**
 * DST: a page in America/New_York, open Sundays 09:00–10:30 local. Slots on
 * the spring-forward (2026-03-08) and fall-back (2026-11-01) Sundays must be
 * at 09:00 local on the right day — 13:00Z under EDT, 14:00Z under EST.
 */

const TZ = "America/New_York";

function page(): BookingPage {
  return {
    id: "p",
    slug: "p",
    name: "P",
    description: "",
    status: "published",
    durationMinutes: 30,
    bufferMinutes: 0,
    workingHours: [{ dayOfWeek: 0, startMinute: 540, endMinute: 630 }],
    timezone: TZ,
    visibleDays: 30,
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

const local = (d: Date) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);

function slotsBetween(from: string, to: string) {
  return computeAvailability({
    page: page(),
    now: new Date(from),
    fromInstant: new Date(from),
    toInstant: new Date(to),
    busy: [],
  });
}

describe("DST in the page's timezone", () => {
  it("spring forward: slots stay at 09:00 local on the Sunday it happens", () => {
    // Window is the whole Saturday–Sunday, ending that Sunday evening.
    const out = slotsBetween("2026-03-07T05:00:00Z", "2026-03-09T03:00:00Z");
    expect(out.map((s) => s.startAt.toISOString())).toEqual([
      "2026-03-08T13:00:00.000Z",
      "2026-03-08T13:30:00.000Z",
      "2026-03-08T14:00:00.000Z",
    ]);
    expect(out.map((s) => local(s.startAt))).toEqual([
      "Sun, 03/08, 09:00",
      "Sun, 03/08, 09:30",
      "Sun, 03/08, 10:00",
    ]);
  });

  it("fall back: slots stay at 09:00 local on the Sunday it happens", () => {
    const out = slotsBetween("2026-10-31T04:00:00Z", "2026-11-02T04:00:00Z");
    expect(out.map((s) => s.startAt.toISOString())).toEqual([
      "2026-11-01T14:00:00.000Z",
      "2026-11-01T14:30:00.000Z",
      "2026-11-01T15:00:00.000Z",
    ]);
    expect(out.map((s) => local(s.startAt))).toEqual([
      "Sun, 11/01, 09:00",
      "Sun, 11/01, 09:30",
      "Sun, 11/01, 10:00",
    ]);
  });

  it("the Sundays either side keep their own offset", () => {
    const out = slotsBetween("2026-03-01T05:00:00Z", "2026-03-16T03:00:00Z");
    expect(out.filter((_, i) => i % 3 === 0).map((s) => s.startAt.toISOString())).toEqual([
      "2026-03-01T14:00:00.000Z", // EST
      "2026-03-08T13:00:00.000Z", // EDT from here
      "2026-03-15T13:00:00.000Z",
    ]);
  });
});

describe("a malformed duration or step", () => {
  const run = (over: Partial<BookingPage>) =>
    computeAvailability({
      page: {
        ...page(),
        timezone: "UTC",
        workingHours: [0, 1, 2, 3, 4, 5, 6].map((d) => ({
          dayOfWeek: d as 0,
          startMinute: 0,
          endMinute: 1440,
        })),
        ...over,
      },
      now: new Date("2026-09-14T00:00:00Z"),
      busy: [],
    });

  it.each([
    ["zero", 0, 0],
    ["negative", -30, 0],
    ["negative step", 30, -45],
    ["zero length with a buffer", 0, 15],
    ["NaN", Number.NaN, 0],
  ])("%s: no slots, no loop", (_label, durationMinutes, bufferMinutes) => {
    expect(run({ durationMinutes, bufferMinutes })).toEqual([]);
  });

  it.each([
    ["zero interval", 0],
    ["NaN interval", Number.NaN],
    ["negative interval", -15],
  ])("%s: no slots, even with a valid duration + buffer", (_label, slotIntervalMinutes) => {
    expect(run({ durationMinutes: 30, bufferMinutes: 0, slotIntervalMinutes })).toEqual([]);
  });

  it("a tiny step is capped per range instead of looping for ever", () => {
    const out = run({ durationMinutes: 0.001, visibleDays: 1 });
    expect(out.length).toBeLessThanOrEqual(2 * 24 * 60); // two calendar days touched
  });
});
