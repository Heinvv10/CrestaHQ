import { describe, expect, it } from "vitest";
import { defaultBookingPageFormData } from "@/lib/booking/defaults";
import { validateBookingPageFormData } from "@/lib/booking/validation";

/** Date-specific hours, before-buffer and slot interval on the page payload. */

const base = { ...defaultBookingPageFormData("demo", "UTC"), name: "Demo" };
const check = (extra: object) => validateBookingPageFormData({ ...base, ...extra });
const r = (startMinute: number, endMinute: number) => ({ startMinute, endMinute });

describe("date overrides", () => {
  it("keeps real dates sorted with sorted ranges; empty ranges = closed", () => {
    const v = check({
      dateOverrides: [
        { date: "2026-12-25", ranges: [] },
        { date: "2026-12-24", ranges: [r(780, 840), r(540, 600)] },
      ],
    });
    expect(v.ok && v.value.dateOverrides).toEqual([
      { date: "2026-12-24", ranges: [r(540, 600), r(780, 840)] },
      { date: "2026-12-25", ranges: [] },
    ]);
  });

  it.each([
    ["an impossible date", [{ date: "2026-02-30", ranges: [] }]],
    ["a non-date", [{ date: "tomorrow", ranges: [] }]],
    ["a repeated date", [{ date: "2026-12-24", ranges: [] }, { date: "2026-12-24", ranges: [] }]],
    ["overlapping ranges", [{ date: "2026-12-24", ranges: [r(540, 660), r(600, 700)] }]],
    ["an inverted range", [{ date: "2026-12-24", ranges: [r(600, 540)] }]],
    ["no ranges list", [{ date: "2026-12-24" }]],
    ["367 entries", Array.from({ length: 367 }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), ranges: [] }))],
  ])("rejects %s", (_label, dateOverrides) => {
    expect(check({ dateOverrides })).toMatchObject({ ok: false });
  });

  it("per host too, kept on the host", () => {
    const v = check({
      hosts: [{ uid: "a", name: "a", dateOverrides: [{ date: "2026-12-24", ranges: [] }] }],
    });
    expect(v.ok && v.value.hosts?.[0].dateOverrides).toEqual([{ date: "2026-12-24", ranges: [] }]);
    expect(
      check({ hosts: [{ uid: "a", name: "a", dateOverrides: [{ date: "x", ranges: [] }] }] }),
    ).toMatchObject({ ok: false });
  });
});

describe("buffers and interval", () => {
  it("defaults to today's behaviour when absent", () => {
    const v = check({});
    expect(v.ok && v.value).toMatchObject({ bufferBeforeMinutes: 0, slotIntervalMinutes: null, dateOverrides: [] });
  });

  it("accepts a before-buffer from the buffer set and a 5-minute-step interval", () => {
    const v = check({ bufferBeforeMinutes: 15, slotIntervalMinutes: 20 });
    expect(v.ok && v.value).toMatchObject({ bufferBeforeMinutes: 15, slotIntervalMinutes: 20 });
  });

  it.each([7, 0, 245, 12.5, "abc"])("rejects interval %s", (slotIntervalMinutes) => {
    expect(check({ slotIntervalMinutes })).toMatchObject({ ok: false });
  });

  it("rejects a before-buffer outside the buffer set", () => {
    expect(check({ bufferBeforeMinutes: 7 })).toMatchObject({ ok: false });
  });
});
