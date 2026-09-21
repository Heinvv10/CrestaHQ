// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Contact } from "@/types/contacts";

vi.mock("@/components/contacts/add-contact-modal", () => ({
  AddContactModal: () => null,
}));
vi.mock("@/context/sub-account-context", () => ({
  useSubAccount: () => ({ subAccount: null, saPath: (p: string) => p }),
}));

import { ContactsLoading, SLOW_AFTER_MS } from "./contacts-empty-states";

/**
 * The contacts page waits for the server before showing the full list, so a
 * lost connection would otherwise leave it on "loading" with no explanation.
 * "Offline" is only claimed when the browser says so.
 */
let el: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let online = true;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  online = true;
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
  el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const status = () => el.querySelector('[role="status"]')?.textContent ?? null;
const mount = (preview: Contact[] | null = null) =>
  act(async () =>
    root.render(createElement(ContactsLoading, { preview, territories: [] })),
  );
const setOnline = (value: boolean) =>
  act(async () => {
    online = value;
    window.dispatchEvent(new Event(value ? "online" : "offline"));
  });

it("says nothing during a normal load", async () => {
  await mount();
  await act(async () => vi.advanceTimersByTime(SLOW_AFTER_MS - 1));
  expect(status()).toBeNull();
});

it("says the load is slow after the threshold, without claiming offline", async () => {
  await mount();
  await act(async () => vi.advanceTimersByTime(SLOW_AFTER_MS));
  expect(status()).toContain("taking longer than usual");
  expect(status()).not.toContain("offline");
});

it("says offline when the browser already is at mount", async () => {
  online = false;
  await mount();
  expect(status()).toContain("You're offline");
});

it("follows the browser going offline and back online", async () => {
  await mount();
  await setOnline(false);
  expect(status()).toContain("You're offline");
  await setOnline(true);
  expect(status()).toBeNull();
});

it("shows the hint above the preview too, not only the skeleton", async () => {
  online = false;
  const preview = [{ id: "c1", name: "A", tags: [] }] as unknown as Contact[];
  await mount(preview);
  expect(status()).toContain("You're offline");
  expect(el.querySelectorAll("tbody tr").length).toBe(1);
});
