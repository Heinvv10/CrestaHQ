// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TaskItem reads "now" once after mount (see task-item.hydration.test.ts for
 * why) — but a long-lived tab must still see the due badge flip from
 * "Today" to "Overdue" as time passes, without the task re-rendering for
 * any other reason. The effect that sets `now` refreshes it every minute.
 */

const ctx = vi.hoisted(() => ({ saPath: (p: string) => `/sa/s1${p}` }));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ctx }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const { TaskItem } = await import("./task-item");

function fakeTimestamp(d: Date) {
  return { toDate: () => d };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const badgeText = () => container.textContent ?? "";

describe("TaskItem — due badge refreshes on a long-lived tab", () => {
  it("moves from Today to Overdue after time passes, without a remount", async () => {
    const due = new Date("2026-06-15T12:00:30.000Z");
    vi.setSystemTime(new Date("2026-06-15T12:00:00.000Z")); // 30s before due
    const task = {
      id: "t1",
      title: "Call back",
      notes: "",
      dueAt: fakeTimestamp(due),
      completed: false,
      completedAt: null,
      contactId: null,
      dealId: null,
      eventId: null,
      agencyId: "ag1",
      subAccountId: "sa1",
      createdByUid: "u1",
      createdAt: null,
      updatedAt: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await act(async () => root.render(createElement(TaskItem, { task })));
    // Flush the mount effect's setNow, which schedules a follow-up render.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(badgeText()).toContain("Today");
    expect(badgeText()).not.toContain("Overdue");

    // Past the due instant, but under the 60s refresh interval — same
    // component instance, no remount.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });

    expect(badgeText()).toContain("Overdue");
  });
});
