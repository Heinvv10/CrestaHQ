// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Timestamp } from "firebase/firestore";
import type { CalendarEvent, EventStatus } from "@/types/events";
import { EVENT_OVERRIDE_TTL_MS } from "@/lib/calendar/event-overrides";
import { useEventOverrides } from "./use-event-overrides";

/**
 * The page-side wiring around lib/calendar/event-overrides.ts: a confirmed
 * change shows over a stale snapshot, is judged against the NEWEST snapshot,
 * is dropped when a snapshot settles it, and expires on a timer.
 */
const H = 3_600_000;
const ev = (id: string, status: EventStatus, startH = 10) =>
  ({ id, status, startAt: Timestamp.fromMillis(startH * H), endAt: Timestamp.fromMillis((startH + 0.5) * H) }) as CalendarEvent;
const shown = (e: CalendarEvent) => `${e.id}:${e.status}@${(e.startAt as Timestamp).toMillis() / H}`;

function mount(initial: CalendarEvent[]) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let latest: ReturnType<typeof useEventOverrides> | null = null;
  let snapshot = initial;
  function Probe() {
    latest = useEventOverrides(snapshot);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const render = () => act(async () => root.render(createElement(Probe)));
  return {
    render,
    rows: () => latest!.events.map(shown),
    rowsRaw: () => latest!.events,
    note: (fn: (h: ReturnType<typeof useEventOverrides>) => void) => act(async () => fn(latest!)),
    snapshot: async (events: CalendarEvent[]) => {
      snapshot = events;
      await render();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("shows a confirmed status, reschedule and delete over a snapshot that has not caught up", async () => {
  const m = mount([ev("a", "scheduled"), ev("b", "scheduled"), ev("c", "scheduled")]);
  await m.render();
  await m.note((h) => h.noteConfirmedStatus("a", "cancelled"));
  await m.note((h) => h.noteConfirmedReschedule("b", new Date(12 * H), new Date(12.5 * H)));
  await m.note((h) => h.noteConfirmedDelete("c"));
  expect(m.rows()).toEqual(["a:cancelled@10", "b:scheduled@12"]);
  // A stale snapshot (same values, new array) changes nothing.
  await m.snapshot([ev("a", "scheduled"), ev("b", "scheduled"), ev("c", "scheduled")]);
  expect(m.rows()).toEqual(["a:cancelled@10", "b:scheduled@12"]);
});

it("drops each override when a snapshot settles it, so later changes are not masked", async () => {
  const m = mount([ev("a", "scheduled"), ev("b", "scheduled"), ev("c", "scheduled")]);
  await m.render();
  await m.note((h) => h.noteConfirmedStatus("a", "cancelled"));
  await m.note((h) => h.noteConfirmedReschedule("b", new Date(12 * H), new Date(12.5 * H)));
  await m.note((h) => h.noteConfirmedDelete("c"));
  // Caught up on all three.
  await m.snapshot([ev("a", "cancelled"), ev("b", "scheduled", 12)]);
  // Then others put a and b back to where the overrides started from.
  await m.snapshot([ev("a", "scheduled"), ev("b", "scheduled", 10)]);
  expect(m.rows()).toEqual(["a:scheduled@10", "b:scheduled@10"]);
});

it("judges a confirmation against the newest snapshot, not the first render's", async () => {
  const m = mount([ev("a", "scheduled"), ev("c", "scheduled")]);
  await m.render();
  // The deltas beat the responses.
  await m.snapshot([ev("a", "cancelled")]);
  await m.note((h) => h.noteConfirmedStatus("a", "cancelled"));
  await m.note((h) => h.noteConfirmedDelete("c"));
  // Someone un-cancels a: no leftover override may keep it "cancelled".
  await m.snapshot([ev("a", "scheduled")]);
  expect(m.rows()).toEqual(["a:scheduled@10"]);
});

it("expires overrides after the TTL, falling back to the snapshot", async () => {
  vi.useFakeTimers();
  const m = mount([ev("a", "scheduled"), ev("c", "scheduled")]);
  await m.render();
  await m.note((h) => h.noteConfirmedStatus("a", "cancelled"));
  await m.note((h) => h.noteConfirmedDelete("c"));
  await act(async () => vi.advanceTimersByTime(EVENT_OVERRIDE_TTL_MS - 1_000));
  expect(m.rows()).toEqual(["a:cancelled@10"]);
  await act(async () => vi.advanceTimersByTime(2_000));
  expect(m.rows()).toEqual(["a:scheduled@10", "c:scheduled@10"]);
});

it("shows a confirmed host reassign until the snapshot catches up", async () => {
  const owned = { ...ev("a", "scheduled"), assignedToUid: "ann", assignedToName: "Ann" } as CalendarEvent;
  const m = mount([owned]);
  await m.render();
  await m.note((h) => h.noteConfirmedAssignee("a", "bob", "Bob"));
  const host = () => m.rowsRaw()[0].assignedToName;
  expect(host()).toBe("Bob");
  await m.snapshot([{ ...owned }]); // stale
  expect(host()).toBe("Bob");
  await m.snapshot([{ ...owned, assignedToUid: "bob", assignedToName: "Bob" }]); // caught up
  await m.snapshot([{ ...owned }]); // someone moved it back
  expect(host()).toBe("Ann");
});

it("shows a created event, a stored reschedule count and a cleared sync error until the snapshot catches up", async () => {
  const failing = {
    ...ev("a", "scheduled"),
    googleSyncError: { message: "Not in Ann's calendar", at: Timestamp.fromMillis(H) },
  } as unknown as CalendarEvent;
  const m = mount([failing]);
  await m.render();
  const created = { ...ev("n", "scheduled", 14), title: "New" } as CalendarEvent;
  await m.note((h) => h.noteConfirmedCreate(created));
  await m.note((h) => h.noteConfirmedReschedule("a", new Date(12 * H), new Date(12.5 * H), 1));
  await m.note((h) => h.noteConfirmedSyncCleared("a"));
  const a = () => m.rowsRaw()[0] as CalendarEvent & { googleSyncError?: unknown };
  expect(m.rows()).toEqual(["a:scheduled@12", "n:scheduled@14"]);
  expect(a().rescheduleCount).toBe(1);
  expect(a().googleSyncError).toBeNull();
  await m.snapshot([{ ...failing }]); // stale
  expect(m.rows()).toEqual(["a:scheduled@12", "n:scheduled@14"]);
  // Caught up: the snapshot's own copies show, once each.
  await m.snapshot([{ ...ev("a", "scheduled", 12), rescheduleCount: 1 }, { ...created, title: "New (delta)" }]);
  expect(m.rowsRaw().map((e) => e.title ?? e.id)).toEqual(["a", "New (delta)"]);
});
