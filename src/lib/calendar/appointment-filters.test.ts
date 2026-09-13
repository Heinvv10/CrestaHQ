import { describe, expect, it } from "vitest";

import {
  appointmentCalendarLabel,
  appointmentOwnerLabel,
  hasActiveFilters,
  matchesFilters,
  matchesSearch,
  matchesTab,
  EMPTY_APPOINTMENT_FILTERS,
  type AppointmentFilters,
} from "./appointment-filters";
import type { CalendarEvent, EventStatus } from "@/types/events";

const NOW = new Date("2030-06-15T12:00:00Z").getTime();

function ts(iso: string) {
  const d = new Date(iso);
  return { toDate: () => d };
}

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: "evt1",
    title: "Consult",
    startAt: ts("2030-06-16T10:00:00Z") as never,
    endAt: ts("2030-06-16T10:30:00Z") as never,
    contactId: "c1",
    location: "",
    notes: "",
    agencyId: "ag1",
    subAccountId: "sa1",
    createdByUid: "u1",
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

describe("matchesTab", () => {
  it("all matches everything regardless of status/time", () => {
    expect(matchesTab(event({ status: "cancelled" }), "all", NOW)).toBe(true);
    expect(
      matchesTab(event({ startAt: ts("2020-01-01T00:00:00Z") as never }), "all", NOW),
    ).toBe(true);
  });

  it("cancelled matches only cancelled status", () => {
    expect(matchesTab(event({ status: "cancelled" }), "cancelled", NOW)).toBe(true);
    expect(matchesTab(event({ status: "completed" }), "cancelled", NOW)).toBe(false);
    expect(matchesTab(event(), "cancelled", NOW)).toBe(false); // default "scheduled"
  });

  it.each<EventStatus>(["scheduled", "awaiting_payment"])(
    "upcoming includes a future %s event",
    (status) => {
      expect(
        matchesTab(event({ status, startAt: ts("2030-06-20T00:00:00Z") as never }), "upcoming", NOW),
      ).toBe(true);
    },
  );

  it("upcoming excludes a future event that already occupies no slot", () => {
    expect(
      matchesTab(
        event({ status: "completed", startAt: ts("2030-06-20T00:00:00Z") as never }),
        "upcoming",
        NOW,
      ),
    ).toBe(false);
  });

  it("upcoming excludes a past-but-still-scheduled event", () => {
    expect(
      matchesTab(
        event({ status: "scheduled", startAt: ts("2020-01-01T00:00:00Z") as never }),
        "upcoming",
        NOW,
      ),
    ).toBe(false);
  });

  it("upcoming excludes an event with no readable start time", () => {
    expect(matchesTab(event({ startAt: null }), "upcoming", NOW)).toBe(false);
  });
});

describe("matchesFilters", () => {
  const base = event({
    bookingPageSlug: "page-a",
    assignedToUid: "host1",
    status: "no_show",
    source: "booking_page",
    startAt: ts("2030-06-16T10:00:00Z") as never,
  });

  it("no active filters matches anything", () => {
    expect(matchesFilters(base, EMPTY_APPOINTMENT_FILTERS)).toBe(true);
  });

  it("filters by booking page", () => {
    expect(
      matchesFilters(base, { ...EMPTY_APPOINTMENT_FILTERS, bookingPageSlug: "page-a" }),
    ).toBe(true);
    expect(
      matchesFilters(base, { ...EMPTY_APPOINTMENT_FILTERS, bookingPageSlug: "page-b" }),
    ).toBe(false);
  });

  it("filters by host", () => {
    expect(matchesFilters(base, { ...EMPTY_APPOINTMENT_FILTERS, hostUid: "host1" })).toBe(true);
    expect(matchesFilters(base, { ...EMPTY_APPOINTMENT_FILTERS, hostUid: "host2" })).toBe(false);
  });

  it("filters by status", () => {
    expect(matchesFilters(base, { ...EMPTY_APPOINTMENT_FILTERS, status: "no_show" })).toBe(true);
    expect(matchesFilters(base, { ...EMPTY_APPOINTMENT_FILTERS, status: "completed" })).toBe(false);
  });

  it("filters by source", () => {
    expect(
      matchesFilters(base, { ...EMPTY_APPOINTMENT_FILTERS, source: "booking_page" }),
    ).toBe(true);
    expect(matchesFilters(base, { ...EMPTY_APPOINTMENT_FILTERS, source: "manual" })).toBe(
      false,
    );
    const manual = event({ source: "manual" });
    expect(matchesFilters(manual, { ...EMPTY_APPOINTMENT_FILTERS, source: "manual" })).toBe(
      true,
    );
  });

  it("filters by appointment-time range (inclusive on both ends)", () => {
    const from = new Date("2030-06-16T09:00:00Z").getTime();
    const to = new Date("2030-06-16T11:00:00Z").getTime();
    const filters: AppointmentFilters = { ...EMPTY_APPOINTMENT_FILTERS, fromMs: from, toMs: to };
    expect(matchesFilters(base, filters)).toBe(true);
    expect(
      matchesFilters(
        { ...base, startAt: ts("2030-06-16T08:00:00Z") as never },
        filters,
      ),
    ).toBe(false);
    expect(
      matchesFilters(
        { ...base, startAt: ts("2030-06-16T12:00:00Z") as never },
        filters,
      ),
    ).toBe(false);
  });

  it("excludes an unreadable start time when a range filter is set", () => {
    const filters: AppointmentFilters = {
      ...EMPTY_APPOINTMENT_FILTERS,
      fromMs: NOW,
    };
    expect(matchesFilters({ ...base, startAt: null }, filters)).toBe(false);
  });
});

describe("hasActiveFilters", () => {
  it("false for the empty filter set, true once any field is set", () => {
    expect(hasActiveFilters(EMPTY_APPOINTMENT_FILTERS)).toBe(false);
    expect(hasActiveFilters({ ...EMPTY_APPOINTMENT_FILTERS, status: "cancelled" })).toBe(true);
  });
});

describe("matchesSearch", () => {
  it("empty query matches everything", () => {
    expect(matchesSearch(event({ title: "Consult" }), "Jane Doe", "")).toBe(true);
  });

  it("matches title case-insensitively", () => {
    expect(matchesSearch(event({ title: "Strategy Call" }), "Jane Doe", "strategy")).toBe(true);
    expect(matchesSearch(event({ title: "Strategy Call" }), "Jane Doe", "onboarding")).toBe(
      false,
    );
  });

  it("matches contact name case-insensitively", () => {
    expect(matchesSearch(event({ title: "Consult" }), "Jane Doe", "jane")).toBe(true);
  });
});

describe("appointmentCalendarLabel", () => {
  it("returns Manual for an event with no booking page", () => {
    expect(appointmentCalendarLabel(event({ bookingPageSlug: null }), new Map())).toBe(
      "Manual",
    );
  });

  it("resolves the booking page's name", () => {
    const names = new Map([["page-a", "Consultations"]]);
    expect(
      appointmentCalendarLabel(event({ bookingPageSlug: "page-a" }), names),
    ).toBe("Consultations");
  });

  it("falls back to the slug when the page name isn't loaded", () => {
    expect(
      appointmentCalendarLabel(event({ bookingPageSlug: "page-a" }), new Map()),
    ).toBe("page-a");
  });
});

describe("appointmentOwnerLabel", () => {
  it("returns the assigned host's name, or an em dash", () => {
    expect(appointmentOwnerLabel(event({ assignedToName: "Sam" }))).toBe("Sam");
    expect(appointmentOwnerLabel(event({ assignedToName: null }))).toBe("—");
    expect(appointmentOwnerLabel(event())).toBe("—");
  });
});
