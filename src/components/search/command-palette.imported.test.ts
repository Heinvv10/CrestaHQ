// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CalendarEvent } from "@/types/events";

/**
 * Cmd+K search never surfaces an event imported from a member's Google
 * Calendar: imported events stay on the calendar only. A booking with the
 * same words in it still matches.
 */

const state = vi.hoisted(() => ({ events: [] as CalendarEvent[], pipelines: Promise.resolve([]), user: { uid: "u1" } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock("@/hooks/use-active-sub-account-id", () => ({
  useActiveSubAccountId: () => ({ subAccountId: "sa1", agencyId: "ag1" }),
}));
vi.mock("@/hooks/use-effective-territory-filter", () => ({
  useEffectiveTerritoryFilter: () => ({ ready: true, filter: null }),
}));
const none = () => () => {};
vi.mock("@/lib/firestore/contacts", () => ({ subscribeToContacts: none }));
vi.mock("@/lib/firestore/tasks", () => ({ subscribeToTasks: none }));
vi.mock("@/lib/firestore/deals", () => ({ subscribeToDeals: none }));
vi.mock("@/lib/firestore/forms", () => ({ subscribeToForms: none }));
vi.mock("@/lib/pipelines/client", () => ({ fetchPipelines: () => state.pipelines }));
vi.mock("@/lib/firestore/events", () => ({
  subscribeToEvents: (_s: unknown, _o: unknown, next: (e: CalendarEvent[]) => void) => {
    next(state.events);
    return () => {};
  },
}));

const { CommandPalette } = await import("./command-palette");

const event = (id: string, title: string, source?: CalendarEvent["source"]) =>
  ({ id, title, location: "", notes: "", startAt: null, source }) as unknown as CalendarEvent;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function search(q: string): Promise<string[]> {
  await act(async () => root.render(createElement(CommandPalette, { open: true, onOpenChange: () => {} })));
  const input = document.body.querySelector("input")!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, q);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return [...document.body.querySelectorAll("p.truncate.font-medium")].map((p) => p.textContent ?? "");
}

it("finds a booking but not an imported Google event with the same words", async () => {
  state.events = [event("b1", "Dentist consult"), event("g1", "Dentist (private)", "google")];
  expect(await search("dentist")).toEqual(["Dentist consult"]);
});
