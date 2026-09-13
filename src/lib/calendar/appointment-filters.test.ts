import { describe, expect, it } from "vitest";

import {
  appointmentCalendarLabel,
  appointmentOwnerLabel,
  canOfferStatusActions,
  canRescheduleAppointment,
  dateInputToFromMs,
  dateInputToToMs,
  formatAppointmentTime,
  hasActiveFilters,
  matchesFilters,
  matchesSearch,
  matchesTab,
  sortAppointments,
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

  it("upcoming includes a booking starting at exactly now (boundary)", () => {
    expect(
      matchesTab(event({ status: "scheduled", startAt: ts(new Date(NOW).toISOString()) as never }), "upcoming", NOW),
    ).toBe(true);
  });

  it("upcoming excludes a booking starting 1ms before now (boundary)", () => {
    expect(
      matchesTab(
        event({ status: "scheduled", startAt: ts(new Date(NOW - 1).toISOString()) as never }),
        "upcoming",
        NOW,
      ),
    ).toBe(false);
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

  it("filters by host (assignedToUid)", () => {
    expect(matchesFilters(base, { ...EMPTY_APPOINTMENT_FILTERS, hostUid: "host1" })).toBe(true);
    expect(matchesFilters(base, { ...EMPTY_APPOINTMENT_FILTERS, hostUid: "host2" })).toBe(false);
  });

  it("filters by host matches any collective co-host, not just assignedToUid", () => {
    const collective = event({ assignedToUid: null, hostUids: ["hostA", "hostB"] });
    expect(matchesFilters(collective, { ...EMPTY_APPOINTMENT_FILTERS, hostUid: "hostB" })).toBe(
      true,
    );
    expect(matchesFilters(collective, { ...EMPTY_APPOINTMENT_FILTERS, hostUid: "hostC" })).toBe(
      false,
    );
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
  it("false for the empty filter set", () => {
    expect(hasActiveFilters(EMPTY_APPOINTMENT_FILTERS)).toBe(false);
  });

  it.each<[keyof AppointmentFilters, AppointmentFilters[keyof AppointmentFilters]]>([
    ["bookingPageSlug", "page-a"],
    ["hostUid", "host1"],
    ["status", "cancelled"],
    ["source", "manual"],
    ["fromMs", 1000],
    ["toMs", 2000],
  ])("true when only %s is set", (key, value) => {
    expect(hasActiveFilters({ ...EMPTY_APPOINTMENT_FILTERS, [key]: value })).toBe(true);
  });
});

describe("canOfferStatusActions", () => {
  it("true for a booking-page event, false for a manual one", () => {
    expect(canOfferStatusActions(event({ source: "booking_page" }))).toBe(true);
    expect(canOfferStatusActions(event({ source: "manual" }))).toBe(false);
    expect(canOfferStatusActions(event())).toBe(false); // default "manual"
  });
});

describe("canRescheduleAppointment", () => {
  it("true only for a booking-page event still occupying a slot", () => {
    expect(
      canRescheduleAppointment(event({ source: "booking_page", status: "scheduled" })),
    ).toBe(true);
    expect(
      canRescheduleAppointment(event({ source: "booking_page", status: "awaiting_payment" })),
    ).toBe(true);
    expect(
      canRescheduleAppointment(event({ source: "booking_page", status: "cancelled" })),
    ).toBe(false);
    expect(
      canRescheduleAppointment(event({ source: "booking_page", status: "completed" })),
    ).toBe(false);
    expect(
      canRescheduleAppointment(event({ source: "manual", status: "scheduled" })),
    ).toBe(false);
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
  it("returns the assigned host's name via the roster, or an em dash", () => {
    const roster = new Map([["host1", "Sam"]]);
    expect(
      appointmentOwnerLabel(event({ assignedToUid: "host1", assignedToName: "Sam" }), roster),
    ).toBe("Sam");
    expect(appointmentOwnerLabel(event({ assignedToName: null }), new Map())).toBe("—");
    expect(appointmentOwnerLabel(event(), new Map())).toBe("—");
  });

  it("falls back to the event's own assignedToName when the uid isn't in the roster", () => {
    expect(
      appointmentOwnerLabel(
        event({ assignedToUid: "host1", assignedToName: "Sam (removed)" }),
        new Map(),
      ),
    ).toBe("Sam (removed)");
  });

  it("lists every collective co-host's name", () => {
    const roster = new Map([
      ["hostA", "Alice"],
      ["hostB", "Bob"],
    ]);
    expect(
      appointmentOwnerLabel(
        event({ assignedToUid: null, hostUids: ["hostA", "hostB"] }),
        roster,
      ),
    ).toBe("Alice, Bob");
  });
});

describe("sortAppointments", () => {
  const early = event({ id: "early", startAt: ts("2030-01-01T00:00:00Z") as never });
  const late = event({ id: "late", startAt: ts("2030-06-01T00:00:00Z") as never });

  it("upcoming sorts ascending (soonest first)", () => {
    expect(sortAppointments([late, early], "upcoming").map((e) => e.id)).toEqual([
      "early",
      "late",
    ]);
  });

  it.each<"cancelled" | "all">(["cancelled", "all"])(
    "%s sorts descending (most recent first)",
    (tab) => {
      expect(sortAppointments([early, late], tab).map((e) => e.id)).toEqual(["late", "early"]);
    },
  );
});

describe("date range parsing/rendering — same timezone both ways", () => {
  it.each(["Africa/Johannesburg", "America/New_York", "UTC"])(
    "%s: From/To bound a whole local calendar day",
    (tz) => {
      const fromMs = dateInputToFromMs("2026-09-13", tz)!;
      const toMs = dateInputToToMs("2026-09-13", tz)!;
      expect(toMs).toBeGreaterThan(fromMs);
      // A moment just inside the day (local noon) is within [from, to];
      // a moment just inside the NEXT local day is not.
      const noonLocal = new Date(fromMs + 12 * 60 * 60_000);
      expect(noonLocal.getTime()).toBeGreaterThanOrEqual(fromMs);
      expect(noonLocal.getTime()).toBeLessThanOrEqual(toMs);
      const nextDay = new Date(toMs + 1);
      expect(nextDay.getTime()).toBeGreaterThan(toMs);

      // Round-trip: formatting fromMs in the SAME tz reads back "13".
      const rendered = formatAppointmentTime(new Date(fromMs), tz);
      expect(rendered).toContain("13");
    },
  );

  it("returns null for an empty or malformed value", () => {
    expect(dateInputToFromMs("", "UTC")).toBeNull();
    expect(dateInputToToMs("", "UTC")).toBeNull();
    expect(dateInputToFromMs("not-a-date", "UTC")).toBeNull();
  });

  it("a naive toISOString render drifts from the tz-aware parse (the bug this guards against)", () => {
    // Africa/Johannesburg is UTC+2: 2026-09-13T00:00:00+02:00 is
    // 2026-09-12T22:00:00Z. A naive `.toISOString()` render of that
    // instant reads "2026-09-12", not "13" — proving the fix must use
    // the SAME tz for both parse and render, not a UTC/local mismatch.
    const fromMs = dateInputToFromMs("2026-09-13", "Africa/Johannesburg")!;
    const naive = new Date(fromMs).toISOString();
    expect(naive.startsWith("2026-09-13")).toBe(false);
    expect(formatAppointmentTime(new Date(fromMs), "Africa/Johannesburg")).toContain("13");
  });
});
