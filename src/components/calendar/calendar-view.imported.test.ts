// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Timestamp } from "firebase/firestore";
import type { CalendarEvent } from "@/types/events";

/** Imported Google events sit on the grid as muted, dashed chips that name their owner. */
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: "ann" } }) }));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ({ isAdmin: true, subAccountId: "sa1" }) }));
const members = vi.hoisted(() => ({ ids: [] as (string | null | undefined)[] }));
vi.mock("@/hooks/use-sub-account-members", () => ({
  useSubAccountMembers: (id: string | null | undefined) => {
    members.ids.push(id);
    return { members: [{ uid: "bob", displayName: "Bob Jones", email: "", role: "admin" }] };
  },
}));
vi.mock("@/lib/firebase/client", () => ({ getFirebaseDb: () => ({}) }));
vi.mock("@/lib/firestore/events", () => ({ updateEvent: vi.fn(), deleteEvent: vi.fn() }));

const { CalendarView } = await import("./calendar-view");

const noon = () => {
  const d = new Date();
  d.setDate(15);
  d.setHours(12, 0, 0, 0);
  return d;
};
const event = (over: Record<string, unknown>) =>
  ({
    id: "e1",
    title: "Standup",
    source: "manual",
    status: "scheduled",
    contactId: null,
    startAt: Timestamp.fromDate(noon()),
    endAt: Timestamp.fromDate(new Date(noon().getTime() + 3_600_000)),
    ...over,
  }) as unknown as CalendarEvent;
const imported = (over: Record<string, unknown> = {}) =>
  event({ id: "gcal_1", title: "Busy", source: "google", importOwnerUid: "bob", importMode: "busy", ...over });

let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  members.ids.length = 0;
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const show = (events: CalendarEvent[]) =>
  act(async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    root.render(createElement(CalendarView, { events, contacts: [] }));
  });
const chips = () => [...document.querySelectorAll<HTMLElement>('[data-imported="true"]')];

it("renders an imported event as a marked chip with its owner's first name", async () => {
  await show([imported()]);
  expect(chips()).toHaveLength(1);
  expect(chips()[0].title).toBe("Imported from Google Calendar");
  expect(chips()[0].textContent).toContain("Busy");
  expect(chips()[0].textContent).toContain("Bob");
  expect(chips()[0].textContent).not.toContain("Jones");
});

it("labels an all-day import All day instead of a time", async () => {
  await show([imported({ allDay: true })]);
  expect(chips()[0].textContent).toContain("All day");
});

it("clicking an imported chip opens the read-only sheet, not the edit form", async () => {
  await show([imported()]);
  await act(async () => chips()[0].click());
  expect(document.querySelector('[data-testid="imported-event-sheet"]')).not.toBeNull();
  expect(document.getElementById("ev-title")).toBeNull();
});

it("leaves manual events unmarked and skips the roster fetch when nothing is imported", async () => {
  await show([event({})]);
  expect(chips()).toHaveLength(0);
  expect(document.body.textContent).toContain("Standup");
  expect(members.ids.every((id) => id === null)).toBe(true);
});

it("fetches the roster once an imported event is on screen", async () => {
  await show([imported()]);
  expect(members.ids).toContain("sa1");
});

it("lists real events before imported ones within a day, so busy blocks never hide one behind +N more", async () => {
  const at = (h: number) => Timestamp.fromDate(new Date(noon().getTime() + h * 3_600_000));
  // Three imported blocks start before the one real event; only three chips fit.
  await show([
    imported({ id: "g1", startAt: at(-3), endAt: at(-2) }),
    imported({ id: "g2", startAt: at(-2), endAt: at(-1) }),
    imported({ id: "g3", startAt: at(-1), endAt: at(0) }),
    event({ id: "real", title: "Client call", startAt: at(2), endAt: at(3) }),
  ]);
  expect(document.body.textContent).toContain("Client call");
  expect(chips()).toHaveLength(2);
  expect(document.body.textContent).toContain("+1 more");
});

it("names the owner in the sheet from the shared roster", async () => {
  await show([imported()]);
  await act(async () => chips()[0].click());
  expect(document.querySelector('[data-testid="imported-event-sheet"]')?.textContent).toContain("Bob Jones");
});
