import { describe, expect, it } from "vitest";
import { defaultBookingPageFormData } from "@/lib/booking/defaults";
import {
  validateBookingPageFormData,
  validateCalendarTypeHosts,
} from "@/lib/booking/validation";

/** The calendar-type fields of the booking-page payload (SP3 K1–K6). */

const base = { ...defaultBookingPageFormData("demo", "UTC"), name: "Demo" };
const host = (uid: string, extra: object = {}) => ({ uid, name: uid, ...extra });

function check(extra: object) {
  return validateBookingPageFormData({ ...base, ...extra });
}

describe("calendar type", () => {
  it("absent: nothing type-related is written, so a legacy page keeps its derived type", () => {
    const v = check({ hosts: [host("a")] });
    expect(v.ok && v.value).toMatchObject({
      calendarType: undefined,
      distribution: undefined,
      seatsPerSlot: undefined,
      services: undefined,
    });
  });

  it("rejects an unknown type", () => {
    expect(check({ calendarType: "rentals" })).toMatchObject({ ok: false });
  });

  it("clears the fields of every other type on a full-replace save", () => {
    const v = check({
      calendarType: "personal",
      distribution: "availability",
      seatsPerSlot: 5,
      services: [{ id: "x", name: "X", durationMinutes: 30 }],
    });
    expect(v.ok && v.value).toMatchObject({
      calendarType: "personal",
      distribution: null,
      seatsPerSlot: null,
      services: null,
    });
  });
});

describe("hosts per type", () => {
  it("personal and class take at most one host", () => {
    expect(check({ calendarType: "personal", hosts: [host("a"), host("b")] })).toMatchObject({ ok: false });
    expect(check({ calendarType: "class", seatsPerSlot: 4, hosts: [host("a"), host("b")] })).toMatchObject({ ok: false });
    expect(check({ calendarType: "personal", hosts: [host("a")] }).ok).toBe(true);
  });

  it("collective needs two, round robin one", () => {
    expect(check({ calendarType: "collective", hosts: [host("a")] })).toMatchObject({ ok: false });
    expect(check({ calendarType: "collective", hosts: [host("a"), host("b")] }).ok).toBe(true);
    expect(check({ calendarType: "round_robin", hosts: [] })).toMatchObject({ ok: false });
  });

  it("the post-resolve re-check uses the same rule", () => {
    expect(validateCalendarTypeHosts("collective", 1).ok).toBe(false);
    expect(validateCalendarTypeHosts(undefined, 0).ok).toBe(true);
  });
});

describe("round robin", () => {
  it("keeps distribution and per-host priority", () => {
    const v = check({
      calendarType: "round_robin",
      distribution: "availability",
      hosts: [host("a", { priority: 3 }), host("b")],
    });
    expect(v.ok && v.value.distribution).toBe("availability");
    expect(v.ok && v.value.hosts).toEqual([{ uid: "a", name: "a", priority: 3 }, { uid: "b", name: "b" }]);
  });

  it("rejects a bad distribution or priority", () => {
    expect(check({ calendarType: "round_robin", hosts: [host("a")], distribution: "random" })).toMatchObject({ ok: false });
    expect(check({ calendarType: "round_robin", hosts: [host("a", { priority: 4 })] })).toMatchObject({ ok: false });
  });
});

describe("class seats", () => {
  it.each([undefined, 1, 2.5, 501, "3"])("rejects %s", (seatsPerSlot) => {
    expect(check({ calendarType: "class", seatsPerSlot })).toMatchObject({ ok: false });
  });

  it("accepts 2 and more", () => {
    const v = check({ calendarType: "class", seatsPerSlot: 2 });
    expect(v.ok && v.value.seatsPerSlot).toBe(2);
  });
});

describe("services", () => {
  const svc = (over: object = {}) => ({ id: "cut", name: "Cut", durationMinutes: 60, description: "", ...over });

  it("normalises a valid list", () => {
    const v = check({ calendarType: "service", services: [svc({ name: "  Cut " })] });
    expect(v.ok && v.value.services).toEqual([
      { id: "cut", name: "Cut", durationMinutes: 60, description: null },
    ]);
  });

  it.each([
    ["none", []],
    ["21 services", Array.from({ length: 21 }, (_, i) => svc({ id: `s${i}` }))],
    ["duplicate ids", [svc(), svc()]],
    ["a bad id", [svc({ id: "a/b" })]],
    ["no name", [svc({ name: " " })]],
    ["an odd duration", [svc({ durationMinutes: 37 })]],
    ["a long description", [svc({ description: "x".repeat(501) })]],
  ])("rejects %s", (_label, services) => {
    expect(check({ calendarType: "service", services })).toMatchObject({ ok: false });
  });
});
