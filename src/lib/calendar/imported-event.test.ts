import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importedEventDays, importedOwnerName } from "./imported-event";

const roster = [
  { uid: "ann", displayName: "Ann Smith" },
  { uid: "bob", displayName: "  " },
];

describe("importedOwnerName", () => {
  it("names the owner from the roster", () => {
    expect(importedOwnerName(roster, "ann")).toBe("Ann Smith");
  });
  it("is null for a member who left, a blank name, or no owner", () => {
    expect(importedOwnerName(roster, "zed")).toBeNull();
    expect(importedOwnerName(roster, "bob")).toBeNull();
    expect(importedOwnerName(roster, null)).toBeNull();
    expect(importedOwnerName(roster, undefined)).toBeNull();
  });
});

describe("importedEventDays", () => {
  const d = (day: number, h = 0, m = 0) => new Date(2030, 0, day, h, m);
  const dates = (days: Date[]) => days.map((x) => x.getDate());
  const wide = { from: d(1), to: d(31) };

  it("covers every day of a multi-day all-day block, end exclusive", () => {
    expect(dates(importedEventDays(d(10), d(13), true, wide))).toEqual([10, 11, 12]);
  });
  it("a one-day all-day event is one day", () => {
    expect(dates(importedEventDays(d(10), d(11), true, wide))).toEqual([10]);
  });
  it("a timed event within a day is one day, and one ending after midnight covers both", () => {
    expect(dates(importedEventDays(d(10, 9), d(10, 10), false, wide))).toEqual([10]);
    expect(dates(importedEventDays(d(10, 23), d(11, 1), false, wide))).toEqual([10, 11]);
  });
  it("a timed event ending exactly at midnight does not spill onto the next day", () => {
    expect(dates(importedEventDays(d(10, 22), d(11), false, wide))).toEqual([10]);
  });
  it("survives a missing or inverted end", () => {
    expect(dates(importedEventDays(d(10), null, true, wide))).toEqual([10]);
    expect(dates(importedEventDays(d(10, 5), d(10, 4), false, wide))).toEqual([10]);
  });
  it("paints only the visible range of a long block, wherever it started", () => {
    // 1 Nov - 10 Dec, viewed in a December grid (a month grid is bounded, a block is not).
    const block = importedEventDays(new Date(2030, 10, 1), new Date(2030, 11, 11), true, {
      from: new Date(2030, 10, 25),
      to: new Date(2030, 11, 8),
    });
    expect(block[0]).toEqual(new Date(2030, 10, 25));
    expect(block.at(-1)).toEqual(new Date(2030, 11, 8));
    expect(block).toHaveLength(14);
    // Entirely outside the range: nothing.
    expect(importedEventDays(d(10), d(12), true, { from: d(20), to: d(25) })).toEqual([]);
  });

  describe("an all-day event stays on its own day for a viewer in another zone", () => {
    const original = process.env.TZ;
    beforeAll(() => {
      process.env.TZ = "Africa/Johannesburg";
    });
    afterAll(() => {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    });
    const viewerRange = () => ({ from: new Date(2030, 9, 20), to: new Date(2030, 10, 10) });
    const paint = (startIso: string, endIso: string) =>
      importedEventDays(new Date(startIso), new Date(endIso), true, viewerRange()).map((x) => `${x.getMonth() + 1}/${x.getDate()}`);

    it("the viewer's zone is SAST here", () => {
      expect(new Date("2030-10-31T00:00:00Z").getHours()).toBe(2);
    });
    it("UTC owner, 31 Oct: exactly 31 Oct (not 31 Oct and 1 Nov)", () => {
      expect(paint("2030-10-31T00:00:00Z", "2030-11-01T00:00:00Z")).toEqual(["10/31"]);
    });
    it("Los Angeles owner, 31 Oct: exactly 31 Oct", () => {
      expect(paint("2030-10-31T07:00:00Z", "2030-11-01T07:00:00Z")).toEqual(["10/31"]);
    });
    it("Auckland owner, 31 Oct: one day (the start day is shifted by one: the documented limit)", () => {
      expect(paint("2030-10-30T11:00:00Z", "2030-10-31T11:00:00Z")).toEqual(["10/30"]);
    });
    it("a 3-day block from a UTC owner is 3 days", () => {
      expect(paint("2030-10-31T00:00:00Z", "2030-11-03T00:00:00Z")).toEqual(["10/31", "11/1", "11/2"]);
    });
  });
});
