import { describe, expect, it } from "vitest";
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

  it("covers every day of a multi-day all-day block, end exclusive", () => {
    expect(dates(importedEventDays(d(10), d(13)))).toEqual([10, 11, 12]);
  });
  it("a one-day all-day event is one day", () => {
    expect(dates(importedEventDays(d(10), d(11)))).toEqual([10]);
  });
  it("a timed event within a day is one day, and one ending after midnight covers both", () => {
    expect(dates(importedEventDays(d(10, 9), d(10, 10)))).toEqual([10]);
    expect(dates(importedEventDays(d(10, 23), d(11, 1)))).toEqual([10, 11]);
  });
  it("a timed event ending exactly at midnight does not spill onto the next day", () => {
    expect(dates(importedEventDays(d(10, 22), d(11)))).toEqual([10]);
  });
  it("is capped, and survives a missing or inverted end", () => {
    expect(importedEventDays(d(1), new Date(2031, 0, 1))).toHaveLength(31);
    expect(dates(importedEventDays(d(10), null))).toEqual([10]);
    expect(dates(importedEventDays(d(10, 5), d(10, 4)))).toEqual([10]);
  });
});
