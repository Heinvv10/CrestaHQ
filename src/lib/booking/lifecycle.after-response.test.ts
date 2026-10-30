import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * A person's booking trigger is handed to after(), which runs only once the
 * response has closed. The trigger is already running by then, so a
 * rejection in between must already have a handler — else it surfaces as an
 * unhandled rejection.
 */

const m = vi.hoisted(() => ({
  afterTasks: [] as Array<() => unknown>,
  // A plain function, not vi.fn(): a spy attaches its own handler to the
  // promise it returns (settledResults), which would hide an unhandled rejection.
  trigger: (() => Promise.resolve(null)) as () => Promise<unknown>,
}));

vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (task: () => unknown) => m.afterTasks.push(task),
}));
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => ({}) }));
vi.mock("@/lib/workflows/engine", () => ({ fireWorkflowTrigger: () => m.trigger() }));

const { fireBookingTrigger } = await import("./lifecycle");

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => unhandled.push(reason);
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  m.afterTasks.length = 0;
  unhandled.length = 0;
  process.on("unhandledRejection", onUnhandled);
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  process.off("unhandledRejection", onUnhandled);
  vi.restoreAllMocks();
});

it("a trigger that rejects before after() runs is handled and logged, not unhandled", async () => {
  const err = new Error("reservation settle failed");
  m.trigger = () => Promise.reject(err);

  const result = await fireBookingTrigger(
    { id: "e1", agencyId: "ag1", subAccountId: "sa1", contactId: "c1", bookingPageSlug: "intro" },
    "event_booked",
  );
  expect(result).toBeNull();
  expect(m.afterTasks).toHaveLength(1);

  // The response has not closed: after() has not run its callback yet.
  await new Promise((r) => setTimeout(r, 20));
  expect(unhandled).toEqual([]);
  expect(warn).toHaveBeenCalledWith("[booking/lifecycle] workflow trigger failed", err);

  await expect(Promise.resolve(m.afterTasks[0]!())).resolves.toBeUndefined();
});
