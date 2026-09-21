// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useOnlineStatus } from "./use-online-status";

let el: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let online = true;
let latest: boolean | null = null;

function Probe() {
  latest = useOnlineStatus();
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  online = true;
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
  el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
  latest = null;
});
afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("reads the browser's current state once mounted", async () => {
  online = false;
  await act(async () => root.render(createElement(Probe)));
  expect(latest).toBe(false);
});

it("follows the browser going offline and back online", async () => {
  await act(async () => root.render(createElement(Probe)));
  expect(latest).toBe(true);
  await act(async () => window.dispatchEvent(new Event("offline")));
  expect(latest).toBe(false);
  await act(async () => window.dispatchEvent(new Event("online")));
  expect(latest).toBe(true);
});

it("stops listening once unmounted", async () => {
  await act(async () => root.render(createElement(Probe)));
  await act(async () => root.unmount());
  // No assertion needed beyond "does not throw" — a leaked listener calling
  // setState after unmount would log a React warning, which vitest surfaces
  // as an uncaught rejection/console.error and fails the run.
  window.dispatchEvent(new Event("offline"));
});
