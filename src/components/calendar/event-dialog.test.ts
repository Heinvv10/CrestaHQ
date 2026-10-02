// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
vi.mock("@/lib/firestore/events", () => ({ updateEvent: vi.fn(), deleteEvent: vi.fn() }));

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
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

const show = (event: CalendarEvent) =>
  act(async () =>
    root.render(createElement(EventDialog, { open: true, onOpenChange: vi.fn(), contacts: [], event })),
  );
const titleInput = () => document.getElementById("ev-title") as HTMLInputElement;
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
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
