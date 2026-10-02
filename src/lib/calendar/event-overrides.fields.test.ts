import { describe, expect, it } from "vitest";
import { Timestamp } from "firebase/firestore";
import type { CalendarEvent, EventStatus } from "@/types/events";
import {
  EVENT_OVERRIDE_OURS_MAX,
  EVENT_OVERRIDE_TTL_MS,
  expireEventOverrides,
  reconcileEventOverrides,
  setEventPatch,
} from "./event-overrides";
import { applyEventOverrides } from "./event-overrides-view";

/** Our own writes in a row, the stored reschedule count, and Retry sync's cleared error. */
const ev = (id: string, status?: EventStatus) => ({ id, status }) as CalendarEvent;
const T0 = 1_000_000;
const H = 3_600_000;
const [OLD_S, OLD_E, NEW_S, NEW_E] = [10 * H, 10.5 * H, 12 * H, 12.5 * H];
const timed = (id: string, startMs: number, endMs: number) =>
  ({ id, startAt: Timestamp.fromMillis(startMs), endAt: Timestamp.fromMillis(endMs) }) as CalendarEvent;
const startMs = (e: CalendarEvent) => (e.startAt as Timestamp).toMillis();
const time = (startAt: number, endAt: number) => ({ time: { startAt, endAt } });

describe("our own writes in a row (A -> B -> C) before any delta", () => {
  // A booking at 10:00 moved to 12:00, then to 15:00, all confirmed while the
  // snapshot still read 10:00.
  const C_S = 15 * H;
  const C_E = 15.5 * H;
  const stale = [timed("a", OLD_S, OLD_E)];
  const viaB = setEventPatch({}, "a", time(NEW_S, NEW_E), stale, T0);
  const viaC = setEventPatch(viaB, "a", time(C_S, C_E), stale, T0 + 1_000);
  const shownStart = (o: typeof viaC, snap: CalendarEvent[]) => startMs(applyEventOverrides(snap, o)[0]);

  it("remembers every value we confirmed, the latest last", () => {
    expect(viaC.a.time).toEqual({
      to: `${C_S}/${C_E}`,
      from: `${OLD_S}/${OLD_E}`,
      ours: [`${NEW_S}/${NEW_E}`, `${C_S}/${C_E}`],
      at: T0 + 1_000,
    });
  });
  it("the B delta arriving first is one of ours, so C keeps showing; the C delta settles it", () => {
    const b = [timed("a", NEW_S, NEW_E)];
    const afterB = reconcileEventOverrides(viaC, b);
    expect(afterB).toBe(viaC);
    expect(shownStart(afterB, b)).toBe(C_S);
    const c = [timed("a", C_S, C_E)];
    const afterC = reconcileEventOverrides(afterB, c);
    expect(afterC).toEqual({});
    expect(shownStart(afterC, c)).toBe(C_S);
  });
  it("a value none of ours still drops it, so a third party's change shows", () => {
    expect(reconcileEventOverrides(viaC, [timed("a", 17 * H, 17.5 * H)])).toEqual({});
  });
  it("the same holds for status: scheduled -> completed -> no-show", () => {
    const one = setEventPatch({}, "a", { status: "completed" }, [ev("a", "scheduled")], T0);
    const two = setEventPatch(one, "a", { status: "no_show" }, [ev("a", "scheduled")], T0);
    expect(applyEventOverrides([ev("a", "completed")], reconcileEventOverrides(two, [ev("a", "completed")]))[0].status).toBe(
      "no_show",
    );
  });
  it("an undo (A -> B -> A) before B's delta keeps A over B's late delta, until the TTL", () => {
    const owner = (uid: string) => [{ id: "a", assignedToUid: uid } as CalendarEvent];
    const toBob = setEventPatch({}, "a", { assignedToUid: "bob" }, owner("ann"), T0);
    const back = setEventPatch(toBob, "a", { assignedToUid: "ann" }, owner("ann"), T0 + 1_000);
    expect(applyEventOverrides(owner("ann"), back)[0].assignedToUid).toBe("ann");
    expect(reconcileEventOverrides(back, owner("ann"))).toBe(back); // A reads as stale
    expect(reconcileEventOverrides(back, owner("bob"))).toBe(back); // B's late delta: ours
    expect(applyEventOverrides(owner("bob"), back)[0].assignedToUid).toBe("ann");
    expect(reconcileEventOverrides(back, owner("cy"))).toEqual({}); // someone else
    expect(expireEventOverrides(back, T0 + 1_000 + EVENT_OVERRIDE_TTL_MS)).toEqual({});
  });
  it("remembers at most the last EVENT_OVERRIDE_OURS_MAX values", () => {
    let o = setEventPatch({}, "a", { rescheduleCount: 1 }, [ev("a")], T0);
    for (let n = 2; n <= 12; n++) o = setEventPatch(o, "a", { rescheduleCount: n }, [ev("a")], T0);
    expect(o.a.rescheduleCount?.ours).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
    expect(EVENT_OVERRIDE_OURS_MAX).toBe(8);
  });
  it("re-confirming a value the snapshot already shows, with nothing else of ours pending, sets nothing", () => {
    const done = setEventPatch(viaB, "a", time(NEW_S, NEW_E), [timed("a", NEW_S, NEW_E)], T0);
    expect(done).toEqual({});
  });
});

describe("reschedule count", () => {
  const counted = (n?: number) => [{ ...timed("a", OLD_S, OLD_E), rescheduleCount: n } as CalendarEvent];
  const o = setEventPatch({}, "a", { ...time(NEW_S, NEW_E), rescheduleCount: 1 }, counted(undefined), T0);

  it("shows the stored count the reschedule's 200 reported, so the Rescheduled badge shows", () => {
    expect(o.a.rescheduleCount).toEqual({ to: 1, from: 0, ours: [1], at: T0 });
    expect(applyEventOverrides(counted(undefined), o)[0].rescheduleCount).toBe(1);
  });
  it("is dropped with the delta, and on a third value", () => {
    expect(reconcileEventOverrides(o, [{ ...timed("a", NEW_S, NEW_E), rescheduleCount: 1 } as CalendarEvent])).toEqual({});
    expect(reconcileEventOverrides(o, counted(5)).a).toEqual({ time: o.a.time });
  });
});

describe("Google sync error cleared by Retry sync", () => {
  const failing = (message: string, atMs: number) =>
    [{ id: "a", googleSyncError: { message, at: Timestamp.fromMillis(atMs) } } as unknown as CalendarEvent];
  const syncError = (e: CalendarEvent) => (e as { googleSyncError?: unknown }).googleSyncError;
  const o = setEventPatch({}, "a", { googleSyncError: null }, failing("Not in Ann's calendar", T0), T0);

  it("hides the error the snapshot still shows", () => {
    expect(syncError(applyEventOverrides(failing("Not in Ann's calendar", T0), o)[0])).toBeNull();
    expect(reconcileEventOverrides(o, failing("Not in Ann's calendar", T0))).toBe(o);
  });
  it("is dropped once the snapshot shows it cleared", () => {
    expect(reconcileEventOverrides(o, [{ id: "a", googleSyncError: null } as unknown as CalendarEvent])).toEqual({});
    expect(reconcileEventOverrides(o, [{ id: "a" } as CalendarEvent])).toEqual({});
  });
  it("a NEW failure (same message, later) is not masked", () => {
    expect(reconcileEventOverrides(o, failing("Not in Ann's calendar", T0 + 5_000))).toEqual({});
  });
  it("sets nothing when the snapshot already shows no error", () => {
    expect(setEventPatch({}, "a", { googleSyncError: null }, [{ id: "a" } as CalendarEvent], T0)).toEqual({});
  });
});
