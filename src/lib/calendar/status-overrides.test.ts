import { describe, expect, it } from "vitest";
import type { CalendarEvent, EventStatus } from "@/types/events";
import {
  STATUS_OVERRIDE_TTL_MS,
  applyStatusOverrides,
  expireStatusOverrides,
  nextStatusOverrideExpiryMs,
  reconcileStatusOverrides,
  setStatusOverride,
} from "./status-overrides";

const ev = (id: string, status?: EventStatus) => ({ id, status }) as CalendarEvent;
const T0 = 1_000_000;
const O = setStatusOverride({}, "a", "cancelled", [ev("a", "scheduled")], T0);

describe("setStatusOverride", () => {
  it("records the latest snapshot's status as `from`", () => {
    expect(O.a).toEqual({ status: "cancelled", from: "scheduled", at: T0 });
  });
  it("sets nothing when the latest snapshot already shows the confirmed status", () => {
    expect(setStatusOverride({}, "a", "cancelled", [ev("a", "cancelled")], T0)).toEqual({});
  });
  it("and clears an older override for that row", () => {
    expect(setStatusOverride(O, "a", "cancelled", [ev("a", "cancelled")], T0)).toEqual({});
  });
  it("still sets one for a row outside the latest snapshot", () => {
    expect(setStatusOverride({}, "z", "cancelled", [ev("a")], T0).z.status).toBe("cancelled");
  });
});

describe("delta lands before the response (no-show -> completed -> no-show)", () => {
  it("never masks the later correction back to no-show", () => {
    // Snapshot already shows 'completed' when the response for 'completed' arrives.
    let o = setStatusOverride({}, "a", "completed", [ev("a", "completed")], T0);
    expect(o).toEqual({});
    // Someone sets it back to no-show: the snapshot shows it, unmasked.
    o = reconcileStatusOverrides(o, [ev("a", "no_show")]);
    expect(applyStatusOverrides([ev("a", "no_show")], o)[0].status).toBe("no_show");
  });
  it("the pre-fix shape (override made against a stale from) WOULD mask it", () => {
    // Documents why 1a matters: an override whose `from` is no_show keeps
    // itself on a snapshot that reads no_show.
    const stale = { a: { status: "completed", from: "no_show", at: T0 } } as const;
    expect(reconcileStatusOverrides(stale, [ev("a", "no_show")])).toBe(stale);
  });
});

describe("expiry", () => {
  it("drops an override once it is older than the TTL, never before", () => {
    expect(expireStatusOverrides(O, T0 + STATUS_OVERRIDE_TTL_MS - 1)).toBe(O);
    expect(expireStatusOverrides(O, T0 + STATUS_OVERRIDE_TTL_MS)).toEqual({});
  });
  it("only drops the expired ones", () => {
    const two = setStatusOverride(O, "b", "completed", [ev("b", "scheduled")], T0 + 30_000);
    expect(Object.keys(expireStatusOverrides(two, T0 + STATUS_OVERRIDE_TTL_MS))).toEqual(["b"]);
  });
  it("a masked third-party revert to `from` heals within the TTL", () => {
    // Blind spot: snapshot at `from` is read as stale and the override stays...
    expect(reconcileStatusOverrides(O, [ev("a", "scheduled")])).toBe(O);
    // ...until it expires.
    expect(expireStatusOverrides(O, T0 + STATUS_OVERRIDE_TTL_MS)).toEqual({});
  });
  it("reports when the next override expires", () => {
    expect(nextStatusOverrideExpiryMs({}, T0)).toBeNull();
    expect(nextStatusOverrideExpiryMs(O, T0 + 10_000)).toBe(STATUS_OVERRIDE_TTL_MS - 10_000);
    expect(nextStatusOverrideExpiryMs(O, T0 + 10 * STATUS_OVERRIDE_TTL_MS)).toBe(0);
  });
});

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
    expect(reconcileStatusOverrides(O, [ev("a")])).toBe(O); // legacy: no status = scheduled
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
    const two = setStatusOverride(O, "b", "completed", [ev("b", "scheduled")], T0);
    const out = reconcileStatusOverrides(two, [ev("a", "cancelled"), ev("b", "scheduled")]);
    expect(Object.keys(out)).toEqual(["b"]);
  });
});
