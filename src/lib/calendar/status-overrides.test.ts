import { describe, expect, it } from "vitest";
import type { CalendarEvent, EventStatus } from "@/types/events";
import {
  applyStatusOverrides,
  reconcileStatusOverrides,
  setStatusOverride,
} from "./status-overrides";

const ev = (id: string, status?: EventStatus) => ({ id, status }) as CalendarEvent;
const O = setStatusOverride({}, "a", "cancelled", "scheduled");

describe("applyStatusOverrides", () => {
  it("shows the overridden status on that row only", () => {
    const out = applyStatusOverrides([ev("a", "scheduled"), ev("b", "scheduled")], O);
    expect(out.map((e) => e.status)).toEqual(["cancelled", "scheduled"]);
  });
  it("returns the same array when there are no overrides", () => {
    const list = [ev("a")];
    expect(applyStatusOverrides(list, {})).toBe(list);
  });
});

describe("reconcileStatusOverrides", () => {
  it("keeps the override on a stale snapshot still at the old status", () => {
    expect(reconcileStatusOverrides(O, [ev("a", "scheduled")])).toBe(O);
    // legacy docs with no status read as scheduled
    expect(reconcileStatusOverrides(O, [ev("a")])).toBe(O);
  });
  it("drops it once the snapshot catches up", () => {
    expect(reconcileStatusOverrides(O, [ev("a", "cancelled")])).toEqual({});
  });
  it("drops it when a later snapshot carries a different status (someone else changed it)", () => {
    expect(reconcileStatusOverrides(O, [ev("a", "completed")])).toEqual({});
  });
  it("keeps it when the event is not in the snapshot window", () => {
    expect(reconcileStatusOverrides(O, [ev("zzz", "scheduled")])).toBe(O);
  });
  it("only drops the overrides that settled", () => {
    const two = setStatusOverride(O, "b", "completed", "scheduled");
    const out = reconcileStatusOverrides(two, [ev("a", "cancelled"), ev("b", "scheduled")]);
    expect(Object.keys(out)).toEqual(["b"]);
  });
});
