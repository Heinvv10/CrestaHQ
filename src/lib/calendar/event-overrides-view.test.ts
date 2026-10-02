import { describe, expect, it } from "vitest";
import { Timestamp } from "firebase/firestore";
import type { CalendarEvent, EventStatus } from "@/types/events";
import {
  EVENT_OVERRIDE_TIMER_PAD_MS,
  EVENT_OVERRIDE_TTL_MS,
  expireEventOverrides,
  nextEventOverrideExpiryMs,
  reconcileEventOverrides,
  setEventDeleted,
  setEventInserted,
  setEventPatch,
} from "./event-overrides";
import { applyEventOverrides, shownEvent } from "./event-overrides-view";

/** A created event shown before its delta, and the event the open dialog is given. */
const ev = (id: string, status?: EventStatus) => ({ id, status }) as CalendarEvent;
const T0 = 1_000_000;
const H = 3_600_000;
const [NEW_S, NEW_E] = [12 * H, 12.5 * H];
const timed = (id: string, startMs: number, endMs: number) =>
  ({ id, startAt: Timestamp.fromMillis(startMs), endAt: Timestamp.fromMillis(endMs) }) as CalendarEvent;
const O = setEventPatch({}, "a", { status: "cancelled" }, [ev("a", "scheduled")], T0);

describe("insertion (a created event)", () => {
  const created = { ...timed("n", NEW_S, NEW_E), title: "New" } as CalendarEvent;
  const ADDED = setEventInserted({}, created, [ev("a")], T0);

  it("shows the created event while the snapshot does not hold it", () => {
    expect(applyEventOverrides([ev("a")], ADDED).map((e) => e.id)).toEqual(["a", "n"]);
    expect(reconcileEventOverrides(ADDED, [ev("a")])).toBe(ADDED);
  });
  it("is dropped once the snapshot holds it, and the snapshot's copy shows", () => {
    const delta = { ...created, title: "New (from the snapshot)" };
    const o = reconcileEventOverrides(ADDED, [ev("a"), delta]);
    expect(o).toEqual({});
    expect(applyEventOverrides([ev("a"), delta], o).map((e) => e.title)).toEqual([undefined, "New (from the snapshot)"]);
  });
  it("is never shown twice", () => {
    expect(applyEventOverrides([ev("a"), created], ADDED).filter((e) => e.id === "n")).toHaveLength(1);
  });
  it("sets nothing when the latest snapshot already holds it", () => {
    expect(setEventInserted({}, created, [created], T0)).toEqual({});
  });
  it("expires like every other override", () => {
    expect(expireEventOverrides(ADDED, T0 + EVENT_OVERRIDE_TTL_MS - 1)).toBe(ADDED);
    expect(expireEventOverrides(ADDED, T0 + EVENT_OVERRIDE_TTL_MS)).toEqual({});
    expect(nextEventOverrideExpiryMs(ADDED, T0)).toBe(EVENT_OVERRIDE_TTL_MS + EVENT_OVERRIDE_TIMER_PAD_MS);
  });
  it("a confirmed delete of it takes it away", () => {
    expect(setEventDeleted(ADDED, "n", [ev("a")], T0)).toEqual({});
  });
});

describe("shownEvent (what the open dialog is given)", () => {
  it("is the page's current copy, overrides applied", () => {
    const picked = ev("a", "scheduled");
    expect(shownEvent(applyEventOverrides([ev("a", "scheduled")], O), picked)?.status).toBe("cancelled");
  });
  it("falls back to the event as picked once it has left the list, and is null with nothing picked", () => {
    const picked = ev("z");
    expect(shownEvent([ev("a")], picked)).toBe(picked);
    expect(shownEvent([ev("a")], null)).toBeNull();
  });
});
