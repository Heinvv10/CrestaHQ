// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CalendarEvent } from "@/types/events";

/**
 * The reassign control hands the page the assignee the assign route's 200
 * reported, so the list's Owner column need not wait for the Listen delta —
 * and nothing on a refusal.
 */
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { uid: "ann" } }) }));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ({ isAdmin: true }) }));
vi.mock("@/lib/firebase/client", () => ({ getFirebaseDb: () => ({}) }));
vi.mock("firebase/firestore", () => ({
  doc: () => ({}),
  getDoc: async () => ({
    data: () => ({ hosts: [{ uid: "ann", name: "Ann" }, { uid: "bob", name: "Bob" }] }),
  }),
}));

const { BookingReassign } = await import("./booking-reassign");

const event = {
  id: "e1",
  subAccountId: "sa1",
  source: "booking_page",
  bookingPageSlug: "page-a",
  assignedToUid: "ann",
  assignedToName: "Ann",
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

async function pick(uid: string, onReassigned: (u: string | null, n: string | null) => void) {
  await act(async () => root.render(createElement(BookingReassign, { event, onReassigned })));
  const select = container.querySelector("select")!;
  expect(select).not.toBeNull();
  await act(async () => {
    select.value = uid;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

const reply = (status: number, body: unknown) =>
  fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));

it("reports the assignee from the route's 200", async () => {
  reply(200, { ok: true, assignedToUid: "bob", assignedToName: "Bob (server)" });
  const onReassigned = vi.fn();
  await pick("bob", onReassigned);
  expect(fetchMock).toHaveBeenCalledWith("/api/events/by-id/e1/assign", expect.anything());
  expect(onReassigned.mock.calls).toEqual([["bob", "Bob (server)"]]);
});

it("reports nothing on a refusal", async () => {
  // The body names an assignee on purpose: only the !res.ok guard keeps this from reporting.
  reply(400, {
    error: "That member isn't active on this sub-account.",
    assignedToUid: "bob",
    assignedToName: "Bob",
  });
  const onReassigned = vi.fn();
  await pick("bob", onReassigned);
  expect(onReassigned).not.toHaveBeenCalled();
});

it("reports nothing when the 200 does not name the assignee", async () => {
  reply(200, { ok: true });
  const onReassigned = vi.fn();
  await pick("bob", onReassigned);
  expect(onReassigned).not.toHaveBeenCalled();
});
