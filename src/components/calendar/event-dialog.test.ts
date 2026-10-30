// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Timestamp } from "firebase/firestore";
import type { CalendarEvent } from "@/types/events";

/**
 * The page hands the open dialog its CURRENT copy of the event (overrides
 * applied), so a confirmed change or a snapshot can arrive while it is open.
 * That must never re-initialise the form and wipe what the operator typed;
 * opening another event must.
 */
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: "ann" } }) }));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ({ isAdmin: true, subAccountId: "sa1" }) }));
vi.mock("@/lib/firebase/client", () => ({ getFirebaseDb: () => ({}) }));
const m = vi.hoisted(() => ({ updateEvent: vi.fn() }));
vi.mock("@/lib/firestore/events", () => ({ updateEvent: m.updateEvent, deleteEvent: vi.fn() }));
vi.mock("firebase/firestore", async (orig) => ({
  ...(await orig<typeof import("firebase/firestore")>()),
  doc: () => ({}),
  getDoc: async () => ({ data: () => ({ hosts: [] }) }),
}));

const { EventDialog } = await import("./event-dialog");

const H = 3_600_000;
const manual = (id: string, title: string, startH: number) =>
  ({
    id,
    title,
    source: "manual",
    status: "scheduled",
    contactId: null,
    startAt: Timestamp.fromMillis(Date.UTC(2030, 0, 1) + startH * H),
    endAt: Timestamp.fromMillis(Date.UTC(2030, 0, 1) + (startH + 1) * H),
  }) as unknown as CalendarEvent;

let root: ReturnType<typeof createRoot>;
const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  m.updateEvent.mockReset().mockResolvedValue(undefined);
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

const show = (event: CalendarEvent, open = true) =>
  act(async () =>
    root.render(createElement(EventDialog, { open, onOpenChange: vi.fn(), contacts: [], event })),
  );
const titleInput = () => document.getElementById("ev-title") as HTMLInputElement;
async function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
    set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("keeps unsaved edits when the open event's data changes", async () => {
  await show(manual("a", "Original", 9));
  expect(titleInput().value).toBe("Original");
  await type(titleInput(), "Typed, not saved");
  // A confirmed change / snapshot arrives for the same event: new object, new data.
  await show({ ...manual("a", "Renamed elsewhere", 12), status: "cancelled" } as CalendarEvent);
  expect(titleInput().value).toBe("Typed, not saved");
});

it("initialises from the event when another event is opened", async () => {
  await show(manual("a", "Original", 9));
  await type(titleInput(), "Typed, not saved");
  await show(manual("b", "Second event", 12));
  expect(titleInput().value).toBe("Second event");
});

/**
 * Save writes only what the operator changed since the form opened, never a
 * difference between the form and the event as it is NOW: a third party's
 * change arriving while the dialog is open must not be sent back.
 */
describe("Save diffs against the form as it was opened", () => {
  // A booking at 09:00-09:30 local, so the time inputs read 09:00.
  const booking = (startH: number, title = "Intro call") =>
    ({
      id: "bk",
      title,
      source: "booking_page",
      status: "scheduled",
      bookingPageSlug: "page-a",
      subAccountId: "sa1",
      contactId: "c1",
      territoryId: "global",
      notes: "",
      startAt: Timestamp.fromDate(new Date(2030, 0, 1, startH, 0)),
      endAt: Timestamp.fromDate(new Date(2030, 0, 1, startH, 30)),
    }) as unknown as CalendarEvent;
  const notes = () => document.getElementById("ev-notes") as HTMLTextAreaElement;
  const save = () =>
    act(async () => {
      const form = document.getElementById("ev-title")!.closest("form")!;
      form.requestSubmit();
    });
  const rescheduleCalls = () =>
    fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/reschedule"));

  // The review's reproduction of the bug (r338 baseline.test.ts), kept as the
  // regression test: same fixture (UTC hours, same id re-rendered 09:00 ->
  // 12:00) and the same plain submit event. It failed on the live-event
  // baseline: Save POSTed /reschedule back to 09:00.
  it("third-party reschedule while open: saving notes only must not POST a reschedule", async () => {
    const H = 3_600_000;
    const reviewed = (startH: number) =>
      ({
        id: "a", title: "Booking", source: "booking_page", bookingPageSlug: "p", status: "scheduled",
        contactId: "c1", territoryId: "t1",
        startAt: Timestamp.fromMillis(Date.UTC(2030, 0, 1) + startH * H),
        endAt: Timestamp.fromMillis(Date.UTC(2030, 0, 1) + (startH + 1) * H),
      }) as unknown as CalendarEvent;
    await show(reviewed(9));
    await show(reviewed(12)); // visitor / another operator moved it; the page's live event updates
    await type(notes(), "Bring ID");
    const form = document.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    const calls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(calls.filter((u) => u.includes("/reschedule"))).toEqual([]);
    expect(m.updateEvent.mock.calls).toEqual([["a", { notes: "Bring ID" }]]);
  });

  it("a third party's title change is not written back", async () => {
    await show(booking(9));
    await show(booking(9, "Renamed by someone else"));
    await type(notes(), "Bring ID");
    await save();
    expect(m.updateEvent.mock.calls).toEqual([["bk", { notes: "Bring ID" }]]);
  });

  it("a manual event's save writes only what the operator changed, and nothing when nothing changed", async () => {
    await show(manual("a", "Original", 9));
    await show(manual("a", "Renamed elsewhere", 12));
    await save();
    expect(m.updateEvent).not.toHaveBeenCalled();
    await type(notes(), "Bring ID");
    await save();
    expect(m.updateEvent.mock.calls).toEqual([["a", { notes: "Bring ID" }]]);
  });

  it("a time the operator changed is rescheduled to the operator's time", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, notifyEmailSent: true }), { status: 200 }));
    await show(booking(9));
    await type(document.getElementById("ev-start") as HTMLInputElement, "10:00");
    await type(document.getElementById("ev-end") as HTMLInputElement, "10:30");
    await save();
    expect(rescheduleCalls()).toHaveLength(1);
    expect(JSON.parse(rescheduleCalls()[0][1].body as string)).toEqual({
      startAt: new Date(2030, 0, 1, 10, 0).toISOString(),
      endAt: new Date(2030, 0, 1, 10, 30).toISOString(),
    });
    expect(m.updateEvent).not.toHaveBeenCalled(); // nothing else changed
  });

  it("re-opening the same event after a server change re-captures what Save diffs against", async () => {
    await show(booking(9));
    await show(booking(9), false); // closed
    await show(booking(12, "Renamed on the server"), true); // reopened, same id
    await type(notes(), "Bring ID");
    await save();
    expect(rescheduleCalls()).toEqual([]);
    expect(m.updateEvent.mock.calls).toEqual([["bk", { notes: "Bring ID" }]]);
  });

  it("a retry after a failed field write saves the fields without POSTing the same reschedule again", async () => {
    fetchMock.mockImplementation(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          notifyEmailSent: true,
          newStartAt: new Date(2030, 0, 1, 10, 0).toISOString(),
          newEndAt: new Date(2030, 0, 1, 10, 30).toISOString(),
        }),
        { status: 200 },
      ),
    );
    m.updateEvent.mockRejectedValueOnce(new Error("offline"));
    await show(booking(9));
    await type(document.getElementById("ev-start") as HTMLInputElement, "10:00");
    await type(document.getElementById("ev-end") as HTMLInputElement, "10:30");
    await type(notes(), "Bring ID");
    await save(); // reschedule 200, field write fails
    await save(); // the operator's retry
    expect(rescheduleCalls()).toHaveLength(1);
    expect(m.updateEvent.mock.calls).toEqual([
      ["bk", { notes: "Bring ID" }],
      ["bk", { notes: "Bring ID" }],
    ]);
  });
});
