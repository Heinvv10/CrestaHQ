// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DateOverridesEditor } from "./date-overrides-editor";
import type { DateOverride } from "@/types/booking";

/**
 * Date-specific hours editor (SP3 review): rows keep their identity while a
 * date is typed, a colliding date is reported instead of silently snapping
 * back, "Add another range" never proposes an overlap, and "Add date"
 * starts from today in the PAGE's timezone.
 */

let root: Root;
let host: HTMLDivElement;
let latest: DateOverride[] = [];

function mount(initial: DateOverride[], timezone = "UTC") {
  function Harness() {
    const [value, setValue] = useState(initial);
    latest = value;
    return createElement(DateOverridesEditor, { value, onChange: setValue, timezone });
  }
  act(() => root.render(createElement(Harness)));
}

/** Set an <input>'s value the way a user would, so React sees the change. */
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const dateInputs = () => [...host.querySelectorAll<HTMLInputElement>('input[type="date"]')];
const button = (text: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes(text))!;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("DateOverridesEditor", () => {
  it("keeps a row (same input element, same position) while its date changes", () => {
    mount([
      { date: "2026-12-01", ranges: [] },
      { date: "2026-12-20", ranges: [] },
    ]);
    const second = dateInputs()[1];
    type(second, "2026-11-05"); // earlier than row 1: must not jump above it
    expect(dateInputs()[1]).toBe(second);
    expect(latest.map((o) => o.date)).toEqual(["2026-12-01", "2026-11-05"]);
  });

  it("reports a date that is already listed and keeps the row unchanged", () => {
    mount([
      { date: "2026-12-01", ranges: [] },
      { date: "2026-12-20", ranges: [] },
    ]);
    type(dateInputs()[1], "2026-12-01");
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/already listed/);
    expect(latest.map((o) => o.date)).toEqual(["2026-12-01", "2026-12-20"]);
  });

  it("adds a range after the latest one, and not past midnight", () => {
    mount([{ date: "2026-12-01", ranges: [{ startMinute: 540, endMinute: 1020 }] }]);
    act(() => button("Add another range").click());
    expect(latest[0].ranges).toEqual([
      { startMinute: 540, endMinute: 1020 },
      { startMinute: 1020, endMinute: 1080 },
    ]);
    act(() => root.unmount());
    root = createRoot(host);
    mount([{ date: "2026-12-01", ranges: [{ startMinute: 1380, endMinute: 1440 }] }]);
    expect(button("Add another range").disabled).toBe(true);
  });

  it("'Add date' starts from today in the page's timezone", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 13:00 UTC on the 14th is already 03:00 on the 15th at UTC+14.
    vi.setSystemTime(new Date("2026-09-14T13:00:00Z"));
    mount([], "Pacific/Kiritimati");
    act(() => button("Add date").click());
    expect(latest.map((o) => o.date)).toEqual(["2026-09-15"]);
  });
});
