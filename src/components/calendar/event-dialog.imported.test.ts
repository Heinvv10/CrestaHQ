// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Timestamp } from "firebase/firestore";
import type { CalendarEvent } from "@/types/events";

/**
 * An event imported from Google (`source: "google"`) opens read-only: no form,
 * no Save, no Delete, no booking actions. Time-only imports show only the time.
 */
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: "ann" } }) }));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ({ isAdmin: true, subAccountId: "sa1" }) }));
vi.mock("@/lib/firebase/client", () => ({ getFirebaseDb: () => ({}) }));
vi.mock("@/lib/firestore/events", () => ({ updateEvent: vi.fn(), deleteEvent: vi.fn() }));

const { EventDialog } = await import("./event-dialog");

const imported = (over: Record<string, unknown> = {}) =>
  ({
    id: "gcal_1",
    title: "Busy",
    location: "",
    source: "google",
    status: "scheduled",
    importOwnerUid: "bob",
    importMode: "busy",
    allDay: false,
    startAt: Timestamp.fromDate(new Date(2030, 0, 1, 9, 0)),
    endAt: Timestamp.fromDate(new Date(2030, 0, 1, 10, 0)),
    ...over,
  }) as unknown as CalendarEvent;

let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

const roster = [
  { uid: "bob", displayName: "Bob Jones" },
  { uid: "eve", displayName: "eve@example.com" },
];
const show = (event: CalendarEvent) =>
  act(async () =>
    root.render(createElement(EventDialog, { open: true, onOpenChange: vi.fn(), contacts: [], event, members: roster })),
  );
const text = () => document.body.textContent ?? "";
const buttons = () => [...document.body.querySelectorAll("button")].map((b) => b.textContent?.trim());

it("opens an imported event read-only with an Imported from Google marker", async () => {
  await show(imported());
  expect(document.querySelector('[data-testid="imported-event-sheet"]')).not.toBeNull();
  expect(text()).toContain("Imported from Google");
  expect(text()).toContain("Bob Jones");
  expect(document.getElementById("ev-title")).toBeNull();
  expect(document.querySelector("form")).toBeNull();
  expect(buttons().filter((b) => /save|delete|cancel booking|mark/i.test(b ?? ""))).toEqual([]);
});

it("a time-only import shows the time and says it is Busy only", async () => {
  await show(imported({ title: "Busy", location: "", notes: "should never show" }));
  expect(text()).toContain("shares this time as Busy only");
  expect(text()).not.toContain("should never show");
});

it("a full-details import shows its place and drops the Busy-only note", async () => {
  await show(imported({ title: "Site visit", location: "12 Main Rd", importMode: "details" }));
  expect(text()).toContain("Site visit");
  expect(text()).toContain("12 Main Rd");
  expect(text()).not.toContain("Busy only");
});

it("an all-day import reads All day", async () => {
  await show(
    imported({
      allDay: true,
      startAt: Timestamp.fromDate(new Date(2030, 0, 1)),
      endAt: Timestamp.fromDate(new Date(2030, 0, 2)),
    }),
  );
  expect(text()).toContain("All day");
});

it("names an owner who has only an email as a team member", async () => {
  await show(imported({ importOwnerUid: "eve" }));
  expect(text()).toContain("a team member");
  expect(text()).not.toContain("eve@example.com");
});

it("a single all-day event shows one date, not a range", async () => {
  await show(
    imported({
      allDay: true,
      startAt: Timestamp.fromDate(new Date(2030, 0, 1)),
      endAt: Timestamp.fromDate(new Date(2030, 0, 2)),
    }),
  );
  expect(text()).not.toMatch(/ - .*All day/);
  await show(
    imported({
      allDay: true,
      startAt: Timestamp.fromDate(new Date(2030, 0, 1)),
      endAt: Timestamp.fromDate(new Date(2030, 0, 3)),
    }),
  );
  expect(text()).toMatch(/ - .*All day/);
});

it("shows the end date when a timed event crosses midnight, and only the time when it does not", async () => {
  const dateOf = (d: Date) => d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  const start = new Date(2030, 0, 1, 23, 0);
  const end = new Date(2030, 0, 2, 1, 0);
  await show(imported({ startAt: Timestamp.fromDate(start), endAt: Timestamp.fromDate(end) }));
  expect(text()).toContain(dateOf(start));
  expect(text()).toContain(dateOf(end));
  await show(
    imported({
      startAt: Timestamp.fromDate(new Date(2030, 0, 1, 9, 0)),
      endAt: Timestamp.fromDate(new Date(2030, 0, 1, 10, 0)),
    }),
  );
  expect(text().split(dateOf(start)).length - 1).toBe(1);
});

it("a manual event still opens the editable form", async () => {
  await show(imported({ source: "manual", title: "Standup", importOwnerUid: null }));
  expect(document.getElementById("ev-title")).not.toBeNull();
  expect(document.querySelector('[data-testid="imported-event-sheet"]')).toBeNull();
});
