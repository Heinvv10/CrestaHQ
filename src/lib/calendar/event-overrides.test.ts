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
  setEventInserted,
  setEventPatch,
  shownEvent,
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
const time = (startAt: number, endAt: number) => ({ time: { startAt, endAt } });
const MOVED = setEventPatch({}, "a", time(NEW_S, NEW_E), [timed("a", OLD_S, OLD_E)], T0);
const GONE = setEventDeleted({}, "a", [ev("a")], T0);

describe("setEventPatch (status)", () => {
  it("records the latest snapshot's status as `from`", () => {
    expect(O.a).toEqual({ status: { to: "cancelled", from: "scheduled", ours: ["cancelled"], at: T0 } });
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
    const stale = { a: { status: { to: "completed", from: "no_show", ours: ["completed"], at: T0 } } };
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
    const both = setEventPatch(O, "a", time(NEW_S, NEW_E), [timed("a", OLD_S, OLD_E)], T0 + 30_000);
    const out = expireEventOverrides(both, T0 + EVENT_OVERRIDE_TTL_MS);
    expect(Object.keys(out.a)).toEqual(["time"]);
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
  it("records start and end, as one unit, against the latest snapshot's", () => {
    expect(MOVED.a).toEqual({
      time: { to: `${NEW_S}/${NEW_E}`, from: `${OLD_S}/${OLD_E}`, ours: [`${NEW_S}/${NEW_E}`], at: T0 },
    });
  });
  it("sets nothing when the latest snapshot already shows the new times", () => {
    expect(setEventPatch({}, "a", time(NEW_S, NEW_E), [timed("a", NEW_S, NEW_E)], T0)).toEqual({});
  });
  it("a move that keeps the start still overrides start and end together", () => {
    // Same start, longer meeting.
    const o = setEventPatch({}, "a", time(OLD_S, NEW_E), [timed("a", OLD_S, OLD_E)], T0);
    expect(Object.keys(o.a)).toEqual(["time"]);
    expect(applyEventOverrides([timed("a", OLD_S, OLD_E)], o).map((e) => [startMs(e), endMs(e)])).toEqual([
      [OLD_S, NEW_E],
    ]);
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
  it("start and end are kept or dropped together: a third party changing only the end drops both", () => {
    const theirs = [timed("a", OLD_S, 11 * H)];
    const o = reconcileEventOverrides(MOVED, theirs);
    expect(o).toEqual({});
    expect(applyEventOverrides(theirs, o).map((e) => [startMs(e), endMs(e)])).toEqual([[OLD_S, 11 * H]]);
  });
  it("a snapshot matching ours on only one of them is someone else's change: both dropped", () => {
    // Our write sets both at once, so no delta of ours reads like this.
    expect(reconcileEventOverrides(MOVED, [timed("a", NEW_S, OLD_E)])).toEqual({});
  });
  it("leaves a status override on the same event alone", () => {
    const both = setEventPatch(O, "a", time(NEW_S, NEW_E), [timed("a", OLD_S, OLD_E)], T0);
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
    const back = setEventPatch({}, "a", time(OLD_S, OLD_E), [timed("a", NEW_S, NEW_E)], T0);
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
      assignedToUid: { to: "bob", from: "ann", ours: ["bob"], at: T0 },
      assignedToName: { to: "Bob", from: "Ann", ours: ["Bob"], at: T0 },
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
    expect(cleared.a.assignedToUid).toEqual({ to: null, from: "ann", ours: [null], at: T0 });
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
