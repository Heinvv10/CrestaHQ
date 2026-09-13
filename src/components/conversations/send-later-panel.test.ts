// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SendLaterPanel } from "./send-later-panel";

/**
 * The Send-later picker refuses an out-of-range time ON SCREEN and books
 * nothing; a double click books once.
 */
let container: HTMLDivElement;
let root: Root;
const onSchedule = vi.fn();
const onClose = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-13T10:00:00Z"));
  onSchedule.mockReset();
  onClose.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () =>
    root.render(createElement(SendLaterPanel, { zone: "UTC", disabled: false, onSchedule, onClose }))
  );
}
async function setValue(v: string) {
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const scheduleButton = () =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Schedule"))!;

it("the picker carries the 7-day max and the zone without repeating it", async () => {
  await render();
  const input = container.querySelector("input")!;
  expect(input.max).toBe("2026-09-20T10:00");
  expect(container.textContent).toContain("Times are in UTC. Up to 7 days ahead.");
});

it.each([
  ["beyond the max", "2026-12-24T09:00", /up to 7 days/],
  ["in the past", "2026-09-12T09:00", /at least a minute/],
])("%s: refused inline, value kept, nothing booked", async (_l, value, message) => {
  await render();
  await setValue(value);
  await act(async () => scheduleButton().click());
  expect(onSchedule).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')?.textContent).toMatch(message);
  expect(container.querySelector("input")!.value).toBe(value);
  expect(onClose).not.toHaveBeenCalled();
});

it("a double click books once", async () => {
  let resolve!: (v: boolean) => void;
  onSchedule.mockReturnValue(new Promise<boolean>((r) => (resolve = r)));
  await render();
  await setValue("2026-09-14T09:00");
  await act(async () => {
    scheduleButton().click();
    scheduleButton().click();
  });
  expect(onSchedule).toHaveBeenCalledTimes(1);
  expect(onSchedule).toHaveBeenCalledWith("2026-09-14T09:00:00.000Z");
  await act(async () => resolve(true));
  expect(onClose).toHaveBeenCalledTimes(1);
});
