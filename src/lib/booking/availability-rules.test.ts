import { describe, expect, it } from "vitest";
import { computePageSlots, type HostBusy, type PageSlot } from "@/lib/booking/page-slots";
import type { BookingHost, BookingPage } from "@/types/booking";

/**
 * SP3 (b): date-specific hours, before/after buffers and slot interval, on
 * top of every calendar type. Page: UTC, Mon 09:00–12:00, 30-min slots.
 */

const NOW = new Date("2026-09-14T06:00:00Z"); // Monday
const iso = (d: string, hhmm: string) => new Date(`${d}T${hhmm}:00Z`);
const MON = "2026-09-14";
const TUE = "2026-09-15";

function page(over: Partial<BookingPage> = {}): BookingPage {
  return {
    id: "p",
    slug: "p",
    name: "P",
    description: "",
    status: "published",
    durationMinutes: 30,
    bufferMinutes: 0,
    workingHours: [{ dayOfWeek: 1, startMinute: 540, endMinute: 720 }],
    timezone: "UTC",
    visibleDays: 14,
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
    ...over,
  };
}

const A: BookingHost = { uid: "a", name: "Ann" };
const B: BookingHost = { uid: "b", name: "Bob" };
const range = (from: string, to: string) => {
  const m = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  return { startMinute: m(from), endMinute: m(to) };
};
const busy = (day: string, s: string, e: string, hostUids: string[] = [], slug: string | null = null): HostBusy => ({
  startAt: iso(day, s),
  endAt: iso(day, e),
  hostUids,
  bookingPageSlug: slug,
});

function slots(p: BookingPage, b: HostBusy[] = [], extra: object = {}, until = `${TUE}T23:59:00Z`): PageSlot[] {
  return computePageSlots({ page: p, now: NOW, toInstant: new Date(until), busy: b, ...extra });
}
/** "MM-DD HH:MM" in UTC, for readable assertions. */
const starts = (list: PageSlot[]) => list.map((s) => s.startAt.toISOString().slice(5, 16).replace("T", " "));

describe("legacy page (no new fields)", () => {
  it("offers exactly what it did: step duration + buffer, weekly hours only", () => {
    expect(starts(slots(page({ bufferMinutes: 15 })))).toEqual([
      "09-14 09:00",
      "09-14 09:45",
      "09-14 10:30",
      "09-14 11:15",
    ]);
  });

  it("an on-grid booking with an after-buffer still leaves the next grid slot", () => {
    const out = slots(page({ bufferMinutes: 15 }), [busy(MON, "09:00", "09:30", [], "p")]);
    expect(starts(out)[0]).toBe("09-14 09:45");
  });
});

describe("date overrides", () => {
  it("replace that weekday's hours for that date only", () => {
    const p = page({ dateOverrides: [{ date: MON, ranges: [range("13:00", "14:00")] }] });
    expect(starts(slots(p))).toEqual(["09-14 13:00", "09-14 13:30"]);
  });

  it("empty ranges close a normally-open date", () => {
    expect(slots(page({ dateOverrides: [{ date: MON, ranges: [] }] }))).toEqual([]);
  });

  it("open a normally-closed date", () => {
    const p = page({ dateOverrides: [{ date: TUE, ranges: [range("09:00", "10:00")] }] });
    expect(starts(slots(p))).toEqual([
      "09-14 09:00",
      "09-14 09:30",
      "09-14 10:00",
      "09-14 10:30",
      "09-14 11:00",
      "09-14 11:30",
      "09-15 09:00",
      "09-15 09:30",
    ]);
  });

  it("open a date even when the page has no weekly hours at all", () => {
    const p = page({ workingHours: [], dateOverrides: [{ date: TUE, ranges: [range("09:00", "09:30")] }] });
    expect(starts(slots(p))).toEqual(["09-15 09:00"]);
  });

  it("host override beats page override beats weekly hours (host custom hours included)", () => {
    const p = page({
      hosts: [
        { ...A, dateOverrides: [{ date: MON, ranges: [range("15:00", "16:00")] }] },
        { ...B, workingHours: [{ dayOfWeek: 1, startMinute: 600, endMinute: 660 }] },
      ],
      dateOverrides: [{ date: MON, ranges: [range("13:00", "14:00")] }],
    });
    const out = slots(p, [], {}, `${MON}T23:59:00Z`);
    expect(out.map((s) => [starts([s])[0], s.hostUids])).toEqual([
      ["09-14 13:00", ["b"]],
      ["09-14 13:30", ["b"]],
      ["09-14 15:00", ["a"]],
      ["09-14 15:30", ["a"]],
    ]);
  });

  it("a host's closed date removes only that host", () => {
    const p = page({ hosts: [{ ...A, dateOverrides: [{ date: MON, ranges: [] }] }, B] });
    const out = slots(p, [], {}, `${MON}T23:59:00Z`);
    expect(out.every((s) => s.hostUids.join() === "b")).toBe(true);
    expect(out).toHaveLength(6);
  });

  it("dates are in the page timezone across a DST change (clocks back)", () => {
    // Europe/London leaves BST at 01:00 UTC on Sun 2026-10-25.
    const p = page({
      timezone: "Europe/London",
      workingHours: [],
      dateOverrides: [
        { date: "2026-10-24", ranges: [range("09:00", "09:30")] },
        { date: "2026-10-25", ranges: [range("09:00", "09:30")] },
      ],
    });
    const out = computePageSlots({ page: p, now: new Date("2026-10-20T00:00:00Z"), busy: [] });
    expect(out.map((s) => s.startAt.toISOString())).toEqual([
      "2026-10-24T08:00:00.000Z", // 09:00 BST
      "2026-10-25T09:00:00.000Z", // 09:00 GMT
    ]);
  });

  it("dates are in the page timezone across a DST change (clocks forward)", () => {
    const p = page({
      timezone: "Europe/London",
      workingHours: [{ dayOfWeek: 0, startMinute: 540, endMinute: 600 }],
      // Closed on the change day itself; open the Saturday before instead.
      dateOverrides: [
        { date: "2026-03-29", ranges: [] },
        { date: "2026-03-28", ranges: [range("09:00", "09:30")] },
      ],
    });
    const out = computePageSlots({ page: p, now: new Date("2026-03-27T00:00:00Z"), busy: [], toInstant: new Date("2026-03-30T00:00:00Z") });
    expect(out.map((s) => s.startAt.toISOString())).toEqual(["2026-03-28T09:00:00.000Z"]);
  });
});

describe("buffers pad every busy interval", () => {
  // Off-grid manual event 10:10–10:20 (shared).
  const manual = [busy(MON, "10:10", "10:20")];

  it("no buffers: only slots overlapping the event go", () => {
    expect(starts(slots(page(), manual))).toEqual([
      "09-14 09:00",
      "09-14 09:30",
      "09-14 10:30",
      "09-14 11:00",
      "09-14 11:30",
    ]);
  });

  it("before-buffer needs free time before a slot: the slot right after the event goes", () => {
    // 10:30 needs 10:15–10:30 free; the event runs to 10:20.
    const out = starts(slots(page({ bufferBeforeMinutes: 15 }), manual));
    expect(out).not.toContain("09-14 10:30");
    expect(out).toContain("09-14 11:00");
    expect(out).toContain("09-14 09:30");
  });

  it("after-buffer needs free time after a slot: the slot right before the event goes", () => {
    const p = page({ bufferMinutes: 15, slotIntervalMinutes: 30 });
    // 09:30 needs 10:00–10:15 free; the event starts 10:10.
    expect(starts(slots(p, manual))).toEqual([
      "09-14 09:00",
      "09-14 10:30",
      "09-14 11:00",
      "09-14 11:30",
    ]);
  });

  it("pads host busy too, per host", () => {
    const p = page({ hosts: [A, B], bufferBeforeMinutes: 15 });
    const out = slots(p, [busy(MON, "10:00", "10:30", ["a"])], {}, `${MON}T23:59:00Z`);
    expect(out.find((s) => starts([s])[0] === "09-14 10:30")?.hostUids).toEqual(["b"]);
  });
});

describe("slot interval", () => {
  it("15 on a 30-min page offers quarter-hour starts", () => {
    const out = starts(slots(page({ slotIntervalMinutes: 15 }), [], {}, `${MON}T23:59:00Z`));
    expect(out.slice(0, 4)).toEqual(["09-14 09:00", "09-14 09:15", "09-14 09:30", "09-14 09:45"]);
    expect(out.at(-1)).toBe("09-14 11:30"); // last start still fits the range
    expect(out).toHaveLength(11);
  });

  it("replaces the legacy duration + buffer step", () => {
    const out = starts(slots(page({ bufferMinutes: 15, slotIntervalMinutes: 60 }), [], {}, `${MON}T23:59:00Z`));
    expect(out).toEqual(["09-14 09:00", "09-14 10:00", "09-14 11:00"]);
  });

  it("applies across services, each slot sized to its service", () => {
    const p = page({
      calendarType: "service",
      slotIntervalMinutes: 30,
      services: [{ id: "cut", name: "Cut", durationMinutes: 60, description: null }],
    });
    const out = slots(p, [], { serviceId: "cut" }, `${MON}T23:59:00Z`);
    expect(starts(out)).toEqual(["09-14 09:00", "09-14 09:30", "09-14 10:00", "09-14 10:30", "09-14 11:00"]);
    expect(out[0].endAt.toISOString()).toBe("2026-09-14T10:00:00.000Z");
  });
});

describe("interplay with calendar types", () => {
  it("collective: each host's date override and the buffers both apply", () => {
    const p = page({
      calendarType: "collective",
      bufferBeforeMinutes: 15,
      hosts: [{ ...A, dateOverrides: [{ date: MON, ranges: [range("10:00", "12:00")] }] }, B],
    });
    const out = slots(p, [busy(MON, "10:10", "10:20", ["b"])], {}, `${MON}T23:59:00Z`);
    // Ann only from 10:00; Bob busy 10:10–10:20 kills 10:00 and (before-buffer) 10:30.
    expect(starts(out)).toEqual(["09-14 11:00", "09-14 11:30"]);
    expect(out[0].hostUids).toEqual(["a", "b"]);
  });

  it("class: seats still count at the slot start; an off-start same-page booking blocks with its padding", () => {
    const p = page({ calendarType: "class", seatsPerSlot: 2, bufferBeforeMinutes: 15, slotIntervalMinutes: 30 });
    const out = slots(p, [busy(MON, "09:00", "09:30", [], "p"), busy(MON, "10:40", "11:10", [], "p")], {}, `${MON}T23:59:00Z`);
    expect(out[0]).toMatchObject({ seatsLeft: 1 });
    // 09:30 needs 09:15–09:30 free (the 09:00 class runs to 09:30); 10:30
    // and 11:00 overlap the 10:40 booking; 11:30 needs 11:15–11:30 (free).
    expect(starts(out)).toEqual(["09-14 09:00", "09-14 10:00", "09-14 11:30"]);
  });

  it("service: a date override shortens the day for every service", () => {
    const p = page({
      calendarType: "service",
      services: [{ id: "cut", name: "Cut", durationMinutes: 60, description: null }],
      dateOverrides: [{ date: MON, ranges: [range("09:00", "10:30")] }],
    });
    expect(starts(slots(p, [], { serviceId: "cut" }, `${MON}T23:59:00Z`))).toEqual(["09-14 09:00"]);
  });
});
