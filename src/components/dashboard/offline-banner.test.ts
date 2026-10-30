// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OfflineBanner } from "./offline-banner";

let el: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let online = true;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  online = true;
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
  el = document.createElement("div");
  document.body.appendChild(el);
  root = createRoot(el);
});
afterEach(async () => {
  await act(async () => root.unmount());
  el.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const status = () => el.querySelector('[role="status"]');

it("renders nothing while online", async () => {
  await act(async () => root.render(createElement(OfflineBanner)));
  expect(status()).toBeNull();
});

it("shows when the browser is offline, and names no cause but connectivity", async () => {
  online = false;
  await act(async () => root.render(createElement(OfflineBanner)));
  expect(status()?.textContent).toContain("You're offline");
});

it("follows the browser back online", async () => {
  await act(async () => root.render(createElement(OfflineBanner)));
  await act(async () => window.dispatchEvent(new Event("offline")));
  expect(status()).not.toBeNull();
  await act(async () => window.dispatchEvent(new Event("online")));
  expect(status()).toBeNull();
});
