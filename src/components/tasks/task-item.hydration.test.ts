// @vitest-environment jsdom
import { act, createElement } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * TaskItem's due-label ("Overdue" / "Today · 3pm" / ...) is computed from
 * `new Date()` read DURING RENDER (`formatDueLabel`). React runs that same
 * component function once on the server (at request time) and again on the
 * client (at hydration time) — if the due instant falls between those two
 * reads, the label differs and React logs a hydration mismatch instead of
 * reusing the server markup.
 *
 * `vi.useFakeTimers` is avoided here — it also freezes React's own
 * scheduler timers and makes hydration bail to a full client re-render for
 * unrelated reasons, which would pass this test vacuously. Instead the
 * global `Date` constructor's no-arg form is stubbed directly, leaving
 * React's real timers alone.
 */

const RealDate = Date;
let frozenNow = 0;
class FrozenDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(frozenNow);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Date's real constructor is a large overload set; forwarding args generically is simplest here.
    else super(...(args as [any]));
  }
  static now() {
    return frozenNow;
  }
}

const ctx = vi.hoisted(() => ({ saPath: (p: string) => `/sa/s1${p}` }));
vi.mock("@/context/sub-account-context", () => ({ useSubAccount: () => ctx }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const { TaskItem } = await import("./task-item");

function fakeTimestamp(d: Date) {
  return { toDate: () => d };
}

let container: HTMLDivElement;
let root: Root | undefined;
const errors: unknown[][] = [];
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  errors.length = 0;
  errorSpy = vi.spyOn(console, "error").mockImplementation((...args) => {
    errors.push(args);
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).Date = FrozenDate;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container.remove();
  errorSpy.mockRestore();
  globalThis.Date = RealDate;
  vi.unstubAllGlobals();
});

const dueLabelText = () => container.querySelector("span")?.textContent ?? "";

describe("TaskItem — due label across server/client render", () => {
  it("hydrates without a text mismatch when the due instant passes between server render and client hydration", async () => {
    // Server render: "now" is 1s BEFORE the due instant — task reads as
    // due later today, not overdue.
    const due = new RealDate("2026-06-15T12:00:00.000Z");
    frozenNow = due.getTime() - 1000;
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
    const serverHtml = renderToString(createElement(TaskItem, { task }));
    expect(serverHtml).not.toContain("Overdue");
    container.innerHTML = serverHtml;

    // Client hydration: "now" has moved past the due instant. A component
    // that reads `new Date()` again during the hydration render produces a
    // DIFFERENT label ("Overdue") than the server sent, and React logs a
    // hydration-mismatch warning instead of reusing the server markup — the
    // very first paint must still say what the server said.
    frozenNow = due.getTime() + 1000;
    // React reports a hydration mismatch by throwing it as a recoverable
    // error off the act() microtask queue (not via console.error), which
    // Node surfaces as an uncaughtException rather than a rejected promise.
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on("uncaughtException", onUncaught);
    try {
      await act(async () => {
        root = hydrateRoot(container, createElement(TaskItem, { task }));
      });
      // Give the queued recoverable-error report a turn to fire.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    } finally {
      process.off("uncaughtException", onUncaught);
    }

    const mismatched = [...errors.flat(), ...uncaught].some(
      (x) => typeof x === "string" || x instanceof Error
        ? /hydrat|did not match/i.test(String(x instanceof Error ? x.message : x))
        : false,
    );
    expect(mismatched).toBe(false);
    expect(dueLabelText()).not.toContain("Overdue");
  });
});
