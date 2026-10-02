import { describe, expect, it } from "vitest";
import { Timestamp } from "firebase/firestore";
import type { CalendarEvent, EventStatus } from "@/types/events";
import { appointmentOwnerLabel, matchesTab } from "./appointment-filters";
import {
  EVENT_OVERRIDE_TIMER_PAD_MS,
  EVENT_OVERRIDE_TTL_MS,
  expireEventOverridesAndRearm,
  applyEventOverrides,
  expireEventOverrides,
  nextEventOverrideExpiryMs,
  reconcileEventOverrides,
  setEventDeleted,
  setEventPatch,
} from "./event-overrides";

const ev = (id: string, status?: EventStatus) => ({ id, status }) as CalendarEvent;
const T0 = 1_000_000;
const O = setEventPatch({}, "a", { status: "cancelled" }, [ev("a", "scheduled")], T0);

// A booking at 10:00-10:30 that the operator moves to 12:00-12:30.
const H = 3_600_000;
const [OLD_S, OLD_E, NEW_S, NEW_E] = [10 * H, 10.5 * H, 12 * H, 12.5 * H];
const timed = (id: string, startMs: number, endMs: number) =>
  ({ id, startAt: Timestamp.fromMillis(startMs), endAt: Timestamp.fromMillis(endMs) }) as CalendarEvent;
const startMs = (e: CalendarEvent) => (e.startAt as Timestamp).toMillis();
const endMs = (e: CalendarEvent) => (e.endAt as Timestamp).toMillis();
const MOVED = setEventPatch({}, "a", { startAt: NEW_S, endAt: NEW_E }, [timed("a", OLD_S, OLD_E)], T0);
const GONE = setEventDeleted({}, "a", [ev("a")], T0);

describe("setEventPatch (status)", () => {
  it("records the latest snapshot's status as `from`", () => {
    expect(O.a).toEqual({ status: { to: "cancelled", from: "scheduled", at: T0 } });
  });
  it("sets nothing when the latest snapshot already shows the confirmed status", () => {
    expect(setEventPatch({}, "a", { status: "cancelled" }, [ev("a", "cancelled")], T0)).toEqual({});
  });
  it("and clears an older override for that row", () => {
    expect(setEventPatch(O, "a", { status: "cancelled" }, [ev("a", "cancelled")], T0)).toEqual({});
  });
  it("still sets one for a row outside the latest snapshot", () => {
    expect(setEventPatch({}, "z", { status: "cancelled" }, [ev("a")], T0).z.status?.to).toBe("cancelled");
  });
});

describe("delta lands before the response (no-show -> completed -> no-show)", () => {
  it("never masks the later correction back to no-show", () => {
    // Snapshot already shows 'completed' when the response for 'completed' arrives.
    let o = setEventPatch({}, "a", { status: "completed" }, [ev("a", "completed")], T0);
    expect(o).toEqual({});
    // Someone sets it back to no-show: the snapshot shows it, unmasked.
    o = reconcileEventOverrides(o, [ev("a", "no_show")]);
    expect(applyEventOverrides([ev("a", "no_show")], o)[0].status).toBe("no_show");
  });
  it("the pre-fix shape (override made against a stale from) WOULD mask it", () => {
    // Documents why 1a matters: an override whose `from` is no_show keeps
    // itself on a snapshot that reads no_show.
    const stale = { a: { status: { to: "completed", from: "no_show", at: T0 } } } as const;
    expect(reconcileEventOverrides(stale, [ev("a", "no_show")])).toBe(stale);
  });
});

describe("expiry", () => {
  it("drops an override once it is older than the TTL, never before", () => {
    expect(expireEventOverrides(O, T0 + EVENT_OVERRIDE_TTL_MS - 1)).toBe(O);
    expect(expireEventOverrides(O, T0 + EVENT_OVERRIDE_TTL_MS)).toEqual({});
  });
  it("only drops the expired ones", () => {
    const two = setEventPatch(O, "b", { status: "completed" }, [ev("b", "scheduled")], T0 + 30_000);
    expect(Object.keys(expireEventOverrides(two, T0 + EVENT_OVERRIDE_TTL_MS))).toEqual(["b"]);
  });
  it("a masked third-party revert to `from` heals within the TTL", () => {
    // Blind spot: snapshot at `from` is read as stale and the override stays...
    expect(reconcileEventOverrides(O, [ev("a", "scheduled")])).toBe(O);
    // ...until it expires.
    expect(expireEventOverrides(O, T0 + EVENT_OVERRIDE_TTL_MS)).toEqual({});
  });
  it("reports when the next override expires", () => {
    expect(nextEventOverrideExpiryMs({}, T0)).toBeNull();
    const pad = EVENT_OVERRIDE_TIMER_PAD_MS;
    expect(nextEventOverrideExpiryMs(O, T0 + 10_000)).toBe(EVENT_OVERRIDE_TTL_MS - 10_000 + pad);
    expect(nextEventOverrideExpiryMs(O, T0 + 10 * EVENT_OVERRIDE_TTL_MS)).toBe(pad);
  });
  it("a timer that fires 1 ms early drops nothing but is re-armed with a fresh object", () => {
    const early = T0 + EVENT_OVERRIDE_TTL_MS - 1;
    const out = expireEventOverridesAndRearm(O, early);
    expect(out).toEqual(O); // nothing expired yet
    expect(out).not.toBe(O); // new identity: the effect re-runs
    expect(nextEventOverrideExpiryMs(out, early)).toBe(1 + EVENT_OVERRIDE_TIMER_PAD_MS);
  });
  it("and on time it drops the override", () => {
    expect(expireEventOverridesAndRearm(O, T0 + EVENT_OVERRIDE_TTL_MS)).toEqual({});
  });
  it("the timer delay already covers the 1 ms early case", () => {
    const wait = nextEventOverrideExpiryMs(O, T0)!;
    expect(T0 + wait - 1).toBeGreaterThanOrEqual(T0 + EVENT_OVERRIDE_TTL_MS);
  });
  it("a reschedule and a deletion expire the same way", () => {
    expect(expireEventOverrides(MOVED, T0 + EVENT_OVERRIDE_TTL_MS - 1)).toBe(MOVED);
    expect(expireEventOverrides(MOVED, T0 + EVENT_OVERRIDE_TTL_MS)).toEqual({});
    expect(expireEventOverrides(GONE, T0 + EVENT_OVERRIDE_TTL_MS - 1)).toBe(GONE);
    expect(expireEventOverrides(GONE, T0 + EVENT_OVERRIDE_TTL_MS)).toEqual({});
    expect(nextEventOverrideExpiryMs(GONE, T0)).toBe(EVENT_OVERRIDE_TTL_MS + EVENT_OVERRIDE_TIMER_PAD_MS);
  });
  it("fields of one event expire on their own clocks", () => {
    // Status confirmed at T0, the reschedule 30 s later.
    const both = setEventPatch(O, "a", { startAt: NEW_S, endAt: NEW_E }, [timed("a", OLD_S, OLD_E)], T0 + 30_000);
    const out = expireEventOverrides(both, T0 + EVENT_OVERRIDE_TTL_MS);
    expect(Object.keys(out.a)).toEqual(["startAt", "endAt"]);
    expect(nextEventOverrideExpiryMs(both, T0)).toBe(EVENT_OVERRIDE_TTL_MS + EVENT_OVERRIDE_TIMER_PAD_MS);
  });
});

describe("applyEventOverrides", () => {
  it("shows the overridden status on that row only", () => {
    const out = applyEventOverrides([ev("a", "scheduled"), ev("b", "scheduled")], O);
    expect(out.map((e) => e.status)).toEqual(["cancelled", "scheduled"]);
  });
  it("returns the same array when there are no overrides", () => {
    const list = [ev("a")];
    expect(applyEventOverrides(list, {})).toBe(list);
  });
  it("shows the confirmed times on a rescheduled row only", () => {
    const out = applyEventOverrides([timed("a", OLD_S, OLD_E), timed("b", OLD_S, OLD_E)], MOVED);
    expect(out.map((e) => [startMs(e), endMs(e)])).toEqual([[NEW_S, NEW_E], [OLD_S, OLD_E]]);
  });
  it("leaves out a deleted row only", () => {
    expect(applyEventOverrides([ev("a"), ev("b")], GONE).map((e) => e.id)).toEqual(["b"]);
  });
});

describe("reconcileEventOverrides (status)", () => {
  it("keeps the override on a stale snapshot still at the old status", () => {
    expect(reconcileEventOverrides(O, [ev("a", "scheduled")])).toBe(O);
    expect(reconcileEventOverrides(O, [ev("a")])).toBe(O); // legacy: no status = scheduled
  });
  it("drops it once the snapshot catches up", () => {
    expect(reconcileEventOverrides(O, [ev("a", "cancelled")])).toEqual({});
  });
  it("drops it when a later snapshot carries a different status (someone else changed it)", () => {
    expect(reconcileEventOverrides(O, [ev("a", "completed")])).toEqual({});
  });
  it("keeps it when the event is not in the snapshot window", () => {
    expect(reconcileEventOverrides(O, [ev("zzz", "scheduled")])).toBe(O);
  });
  it("only drops the overrides that settled", () => {
    const two = setEventPatch(O, "b", { status: "completed" }, [ev("b", "scheduled")], T0);
    const out = reconcileEventOverrides(two, [ev("a", "cancelled"), ev("b", "scheduled")]);
    expect(Object.keys(out)).toEqual(["b"]);
  });
});

describe("reschedule", () => {
  it("records each time against the latest snapshot's", () => {
    expect(MOVED.a).toEqual({
      startAt: { to: NEW_S, from: OLD_S, at: T0 },
      endAt: { to: NEW_E, from: OLD_E, at: T0 },
    });
  });
  it("sets nothing when the latest snapshot already shows the new times", () => {
    expect(setEventPatch({}, "a", { startAt: NEW_S, endAt: NEW_E }, [timed("a", NEW_S, NEW_E)], T0)).toEqual({});
  });
  it("overrides only the time that moved", () => {
    // Same start, longer meeting.
    const o = setEventPatch({}, "a", { startAt: OLD_S, endAt: NEW_E }, [timed("a", OLD_S, OLD_E)], T0);
    expect(Object.keys(o.a)).toEqual(["endAt"]);
  });
  it("keeps the override while the snapshot is stale", () => {
    expect(reconcileEventOverrides(MOVED, [timed("a", OLD_S, OLD_E)])).toBe(MOVED);
  });
  it("drops it once the snapshot catches up", () => {
    expect(reconcileEventOverrides(MOVED, [timed("a", NEW_S, NEW_E)])).toEqual({});
  });
  it("drops it when a third party moves the booking again, so their time shows", () => {
    const theirs = [timed("a", 15 * H, 15.5 * H)];
    const o = reconcileEventOverrides(MOVED, theirs);
    expect(o).toEqual({});
    expect(startMs(applyEventOverrides(theirs, o)[0])).toBe(15 * H);
  });
  it("is judged per field: a third party changing only the end keeps our start", () => {
    const o = reconcileEventOverrides(MOVED, [timed("a", OLD_S, 11 * H)]);
    expect(Object.keys(o.a)).toEqual(["startAt"]);
  });
  it("leaves a status override on the same event alone", () => {
    const both = setEventPatch(O, "a", { startAt: NEW_S, endAt: NEW_E }, [timed("a", OLD_S, OLD_E)], T0);
    // The reschedule delta lands; the (legacy, no-status) row still reads scheduled.
    const out = reconcileEventOverrides(both, [timed("a", NEW_S, NEW_E)]);
    expect(out.a).toEqual({ status: O.a.status });
  });
});

describe("deletion", () => {
  it("hides the row while the snapshot still holds it", () => {
    expect(GONE.a).toEqual({ deleted: { at: T0 } });
    expect(reconcileEventOverrides(GONE, [ev("a")])).toBe(GONE);
  });
  it("is dropped once the snapshot no longer holds the event", () => {
    expect(reconcileEventOverrides(GONE, [ev("b")])).toEqual({});
  });
  it("sets nothing when the latest snapshot already dropped the event", () => {
    expect(setEventDeleted({}, "a", [ev("b")], T0)).toEqual({});
  });
  it("replaces a patch on the same event", () => {
    expect(setEventDeleted(O, "a", [ev("a")], T0).a).toEqual({ deleted: { at: T0 } });
  });
});

describe("tab membership follows the overridden values", () => {
  const NOW = 11 * H;
  it("a booking rescheduled from the past into the future joins Upcoming, and back", () => {
    const row = [timed("a", OLD_S, OLD_E)]; // 10:00, already past at 11:00
    expect(matchesTab(row[0], "upcoming", NOW)).toBe(false);
    expect(matchesTab(applyEventOverrides(row, MOVED)[0], "upcoming", NOW)).toBe(true);
    const back = setEventPatch({}, "a", { startAt: OLD_S, endAt: OLD_E }, [timed("a", NEW_S, NEW_E)], T0);
    expect(matchesTab(applyEventOverrides([timed("a", NEW_S, NEW_E)], back)[0], "upcoming", NOW)).toBe(false);
  });
  it("a deleted event leaves every tab's count", () => {
    const rows = applyEventOverrides([timed("a", NEW_S, NEW_E), timed("b", NEW_S, NEW_E)], GONE);
    expect(rows.filter((e) => matchesTab(e, "upcoming", NOW)).length).toBe(1);
    expect(rows.filter((e) => matchesTab(e, "all", NOW)).length).toBe(1);
  });
});

describe("host reassign", () => {
  const owned = (id: string, uid: string | null, name: string | null) =>
    ({ id, assignedToUid: uid, assignedToName: name }) as CalendarEvent;
  const BOB = setEventPatch({}, "a", { assignedToUid: "bob", assignedToName: "Bob" }, [owned("a", "ann", "Ann")], T0);
  const names = new Map([["ann", "Ann"], ["bob", "Bob"], ["cy", "Cy"]]);

  it("records the assignee against the latest snapshot's and shows it", () => {
    expect(BOB.a).toEqual({
      assignedToUid: { to: "bob", from: "ann", at: T0 },
      assignedToName: { to: "Bob", from: "Ann", at: T0 },
    });
    const row = applyEventOverrides([owned("a", "ann", "Ann")], BOB)[0];
    expect(appointmentOwnerLabel(row, names)).toBe("Bob");
  });
  it("keeps the override while the snapshot is stale", () => {
    expect(reconcileEventOverrides(BOB, [owned("a", "ann", "Ann")])).toBe(BOB);
  });
  it("drops it once the snapshot catches up", () => {
    expect(reconcileEventOverrides(BOB, [owned("a", "bob", "Bob")])).toEqual({});
  });
  it("drops it when someone else reassigns it again, so their host shows", () => {
    const theirs = [owned("a", "cy", "Cy")];
    const o = reconcileEventOverrides(BOB, theirs);
    expect(o).toEqual({});
    expect(appointmentOwnerLabel(applyEventOverrides(theirs, o)[0], names)).toBe("Cy");
  });
  it("a missing assignee reads as null, so clearing the host is a confirmable value", () => {
    const cleared = setEventPatch({}, "a", { assignedToUid: null, assignedToName: null }, [owned("a", "ann", "Ann")], T0);
    expect(cleared.a.assignedToUid).toEqual({ to: null, from: "ann", at: T0 });
    expect(reconcileEventOverrides(cleared, [{ id: "a" } as CalendarEvent])).toEqual({});
  });
  it("clearing the host of a doc that never had one is already shown: nothing set", () => {
    const legacy = [{ id: "a" } as CalendarEvent];
    expect(setEventPatch({}, "a", { assignedToUid: null, assignedToName: null }, legacy, T0)).toEqual({});
  });
  it("sets nothing when the latest snapshot already shows the new host", () => {
    expect(setEventPatch({}, "a", { assignedToUid: "bob", assignedToName: "Bob" }, [owned("a", "bob", "Bob")], T0)).toEqual({});
  });
  it("expires like every other override", () => {
    expect(expireEventOverrides(BOB, T0 + EVENT_OVERRIDE_TTL_MS)).toEqual({});
  });
});
