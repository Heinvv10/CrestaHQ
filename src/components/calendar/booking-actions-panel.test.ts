// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CalendarEvent } from "@/types/events";

/**
 * The dialog's "Mark as paid" hands the page the status the mark-paid
 * route's 200 confirmed (what the list and grid override with), and
 * nothing on a refusal.
 */
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: "ann" } }) }));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ({ isAdmin: true, subAccountId: "sa1" }) }));
vi.mock("@/lib/firebase/client", () => ({ getFirebaseDb: () => ({}) }));
vi.mock("@/lib/firestore/events", () => ({ updateEvent: vi.fn(), deleteEvent: vi.fn() }));
vi.mock("firebase/firestore", async (orig) => ({
  ...(await orig<typeof import("firebase/firestore")>()),
  doc: () => ({}),
  getDoc: async () => ({ data: () => ({ hosts: [] }) }),
}));

const { BookingActionsPanel } = await import("./event-dialog");

const event = {
  id: "e1",
  subAccountId: "sa1",
  source: "booking_page",
  bookingPageSlug: "page-a",
  status: "awaiting_payment",
} as CalendarEvent;

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

async function markPaid(status: number, body: unknown) {
  fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));
  const onStatusChange = vi.fn();
  await act(async () =>
    root.render(
      createElement(BookingActionsPanel, {
        event,
        onStatusChange,
        onReassigned: vi.fn(),
        onSyncCleared: vi.fn(),
      }),
    ),
  );
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Mark as paid"))!;
  expect(button).toBeDefined();
  await act(async () => button.click());
  expect(fetchMock).toHaveBeenCalledWith("/api/events/by-id/e1/mark-paid", { method: "POST" });
  return onStatusChange;
}

it("feeds the confirmed status to the page on the route's 200", async () => {
  const onStatusChange = await markPaid(200, { ok: true, status: "scheduled" });
  expect(onStatusChange.mock.calls).toEqual([["scheduled"]]);
});

it("feeds nothing when the route refuses", async () => {
  const onStatusChange = await markPaid(409, { error: "Already paid", status: "scheduled" });
  expect(onStatusChange).not.toHaveBeenCalled();
});
