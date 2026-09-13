import { describe, expect, it } from "vitest";
import { pageCalendarType } from "@/lib/booking/calendar-types";
import {
  assignBookingHosts,
  computePageSlots,
  pickRoundRobinHost,
  selectableHostUid,
  type HostBusy,
  type PageSlot,
} from "@/lib/booking/page-slots";
import type { BookingHost, BookingPage } from "@/types/booking";

// Monday 2026-09-14, UTC page, open 09:00–12:00 → six 30-min slots.
const NOW = new Date("2026-09-14T06:00:00Z");
const DAY_END = new Date("2026-09-14T23:59:00Z");
const at = (hhmm: string) => new Date(`2026-09-14T${hhmm}:00Z`);

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

function busy(
  start: string,
  end: string,
  hostUids: string[] = [],
  bookingPageSlug: string | null = null,
): HostBusy {
  return { startAt: at(start), endAt: at(end), hostUids, bookingPageSlug };
}

function slots(p: BookingPage, b: HostBusy[], extra: object = {}): PageSlot[] {
  return computePageSlots({ page: p, now: NOW, toInstant: DAY_END, busy: b, ...extra });
}

const starts = (list: PageSlot[]) =>
  list.map((s) => s.startAt.toISOString().slice(11, 16));

describe("pageCalendarType", () => {
  it("derives legacy pages from hosts, and an explicit type wins", () => {
    expect(pageCalendarType({})).toBe("personal");
    expect(pageCalendarType({ hosts: [A] })).toBe("round_robin");
    expect(pageCalendarType({ hosts: [A], calendarType: "collective" })).toBe(
      "collective",
    );
  });
});

describe("hostless page (legacy single shared schedule)", () => {
  it("is blocked by every occupying event, assigned or not", () => {
    const out = slots(page(), [busy("09:00", "09:30", ["x"]), busy("10:00", "10:30")]);
    expect(starts(out)).toEqual(["09:30", "10:30", "11:00", "11:30"]);
    expect(out.every((s) => s.hostUids.length === 0)).toBe(true);
  });
});

describe("round robin", () => {
  const rr = page({ hosts: [A, B] });

  it("offers a slot while any host is free, naming who is free", () => {
    const out = slots(rr, [busy("09:00", "09:30", ["a"])]);
    expect(out[0]).toMatchObject({ hostUids: ["b"] });
    expect(starts(out)).toHaveLength(6);
  });

  it("a shared event blocks every host; a non-host's event blocks none", () => {
    const out = slots(rr, [busy("09:00", "09:30"), busy("09:30", "10:00", ["z"])]);
    expect(starts(out)[0]).toBe("09:30");
    expect(out[0].hostUids).toEqual(["a", "b"]);
  });

  it("a collective event blocks every host it lists", () => {
    const out = slots(rr, [busy("09:00", "09:30", ["a", "b"])]);
    expect(starts(out)[0]).toBe("09:30");
  });

  it("onlyHostUid narrows to the chosen host", () => {
    const out = slots(rr, [busy("09:00", "09:30", ["a"])], { onlyHostUid: "a" });
    expect(starts(out)[0]).toBe("09:30");
  });

  it("a reschedule restriction checks the event's own host only", () => {
    const b1 = [busy("10:00", "10:30", ["b"]), busy("11:00", "11:30", ["a"])];
    const out = slots(rr, b1, { restrictToHostUids: ["a"] });
    expect(starts(out)).toContain("10:00"); // Bob busy, Ann free → Ann's slot
    expect(starts(out)).not.toContain("11:00"); // Ann busy → gone for her
    const none = slots(rr, b1, { restrictToHostUids: ["gone"] });
    expect(none).toEqual([]);
  });
});

describe("personal with one host", () => {
  it("only that host's events and shared events block it", () => {
    const p = page({ calendarType: "personal", hosts: [A] });
    const out = slots(p, [
      busy("09:00", "09:30", ["someone-else"]),
      busy("10:00", "10:30", ["a"]),
      busy("11:00", "11:30"),
    ]);
    expect(starts(out)).toEqual(["09:00", "09:30", "10:30", "11:30"]);
  });
});

describe("collective", () => {
  const col = page({ calendarType: "collective", hosts: [A, B] });

  it("offers a slot only when every host is free", () => {
    const out = slots(col, [busy("09:00", "09:30", ["a"]), busy("10:00", "10:30", ["b"])]);
    expect(starts(out)).toEqual(["09:30", "10:30", "11:00", "11:30"]);
    expect(out[0].hostUids).toEqual(["a", "b"]);
  });

  it("intersects each host's own working hours", () => {
    const p = page({
      calendarType: "collective",
      hosts: [
        { ...A, workingHours: [{ dayOfWeek: 1, startMinute: 540, endMinute: 600 }] },
        B,
      ],
    });
    expect(starts(slots(p, []))).toEqual(["09:00", "09:30"]);
  });

  it("applies the day cap after the intersection", () => {
    const p = page({ calendarType: "collective", hosts: [A, B], maxPerDay: 2 });
    // Ann is busy for the first two slots; a per-host cap would have spent
    // Bob's allowance on them and offered nothing.
    const out = slots(p, [busy("09:00", "10:00", ["a"])]);
    expect(starts(out)).toEqual(["10:00", "10:30"]);
  });
});

describe("class", () => {
  const cls = page({ calendarType: "class", seatsPerSlot: 3 });

  it("counts same-page bookings at the slot start as seats", () => {
    const two = [busy("09:00", "09:30", [], "p"), busy("09:00", "09:30", [], "p")];
    const out = slots(cls, two);
    expect(out[0]).toMatchObject({ seatsLeft: 1 });
    expect(starts(out)[0]).toBe("09:00");
    expect(out[1]).toMatchObject({ seatsLeft: 3 });

    const full = slots(cls, [...two, busy("09:00", "09:30", [], "p")]);
    expect(starts(full)[0]).toBe("09:30");
  });

  it("other pages' events block; a same-page event at another start blocks", () => {
    const out = slots(cls, [
      busy("10:00", "10:30", [], "other"),
      busy("11:15", "11:45", [], "p"),
    ]);
    expect(starts(out)).toEqual(["09:00", "09:30", "10:30"]);
  });

  it("the day cap counts offered class slots, after full ones drop", () => {
    const p = page({ calendarType: "class", seatsPerSlot: 2, maxPerDay: 2 });
    const full = [busy("09:00", "09:30", [], "p"), busy("09:00", "09:30", [], "p")];
    expect(starts(slots(p, full))).toEqual(["09:30", "10:00"]);
  });
});

describe("service", () => {
  const svc = page({
    calendarType: "service",
    services: [
      { id: "cut", name: "Cut", durationMinutes: 60, description: null },
      { id: "trim", name: "Trim", durationMinutes: 30, description: null },
    ],
  });

  it("sizes slots to the picked service", () => {
    const out = slots(svc, [], { serviceId: "cut" });
    expect(starts(out)).toEqual(["09:00", "10:00", "11:00"]);
    expect(out[0].endAt.getTime() - out[0].startAt.getTime()).toBe(60 * 60_000);
    expect(starts(slots(svc, [], { serviceId: "trim" }))).toHaveLength(6);
  });

  it("offers nothing without a known service", () => {
    expect(slots(svc, [], { serviceId: "nope" })).toEqual([]);
    expect(slots(svc, [])).toEqual([]);
  });
});

describe("host selection", () => {
  it("is honoured only on opted-in round-robin/service pages for a real host", () => {
    const on = page({ hosts: [A, B], allowHostSelection: true });
    expect(selectableHostUid(on, "a")).toBe("a");
    expect(selectableHostUid(on, "zz")).toBeNull();
    expect(selectableHostUid({ ...on, allowHostSelection: false }, "a")).toBeNull();
    expect(selectableHostUid({ ...on, calendarType: "collective" }, "a")).toBeNull();
  });
});

describe("pickRoundRobinHost", () => {
  const high: BookingHost = { uid: "h", name: "H", priority: 3 };
  const mid: BookingHost = { uid: "m", name: "M" };
  const low: BookingHost = { uid: "l", name: "L", priority: 1 };

  it("equal: least loaded first, ties → higher priority, then page order", () => {
    const load = new Map([["h", 5], ["m", 1], ["l", 1]]);
    expect(pickRoundRobinHost([high, low, mid], load, "equal")?.uid).toBe("m");
    expect(pickRoundRobinHost([low, mid], new Map(), null)?.uid).toBe("m");
    const tie = { ...mid, uid: "m2" };
    expect(pickRoundRobinHost([mid, tie], new Map(), undefined)?.uid).toBe("m");
  });

  it("availability: highest priority first, ties → least loaded", () => {
    const load = new Map([["h", 5], ["m", 1]]);
    expect(pickRoundRobinHost([mid, low, high], load, "availability")?.uid).toBe("h");
    const h2 = { ...high, uid: "h2" };
    expect(
      pickRoundRobinHost([high, h2], new Map([["h", 3], ["h2", 1]]), "availability")?.uid,
    ).toBe("h2");
  });

  it("returns null when nobody is free", () => {
    expect(pickRoundRobinHost([], new Map(), "equal")).toBeNull();
  });
});

describe("assignBookingHosts", () => {
  const slot = (hostUids: string[]): PageSlot => ({
    startAt: at("09:00"),
    endAt: at("09:30"),
    hostUids,
  });

  it("hostless page: no host stamped", () => {
    expect(assignBookingHosts(page(), slot([]), new Map())).toEqual({
      assignedToUid: null,
      assignedToName: null,
      hostUids: null,
    });
  });

  it("collective: every host, owner is the first", () => {
    const p = page({ calendarType: "collective", hosts: [A, B] });
    expect(assignBookingHosts(p, slot(["a", "b"]), new Map())).toEqual({
      assignedToUid: "a",
      assignedToName: "Ann",
      hostUids: ["a", "b"],
    });
  });

  it("round robin: one free host by the page's distribution", () => {
    const p = page({
      hosts: [A, { ...B, priority: 3 }],
      distribution: "availability",
    });
    const load = new Map([["b", 9]]);
    expect(assignBookingHosts(p, slot(["a", "b"]), load)?.assignedToUid).toBe("b");
    expect(
      assignBookingHosts({ ...p, distribution: "equal" }, slot(["a", "b"]), load)
        ?.assignedToUid,
    ).toBe("a");
  });

  it("hosted page with nobody free: null (the caller's 409)", () => {
    expect(assignBookingHosts(page({ hosts: [A] }), slot([]), new Map())).toBeNull();
  });
});
