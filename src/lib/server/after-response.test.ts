import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  afterTasks: [] as Array<() => unknown>,
  afterThrows: false,
}));

vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (task: () => unknown) => {
    if (m.afterThrows) throw new Error("`after` was called outside a request scope");
    m.afterTasks.push(task);
  },
}));

import { flushAfterResponse, runAfterResponse } from "./after-response";

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  m.afterTasks.length = 0;
  m.afterThrows = false;
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("runAfterResponse", () => {
  it("hands the work to after() and does not run it before the response", async () => {
    const fn = vi.fn(async () => {});
    runAfterResponse(fn);
    expect(m.afterTasks).toHaveLength(1);
    await flush();
    expect(fn).not.toHaveBeenCalled();
    await m.afterTasks[0]!();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("after()'s callback settles only once the work settles", async () => {
    let release!: () => void;
    let settled = false;
    runAfterResponse(() => new Promise<void>((r) => (release = r)));
    const callback = Promise.resolve(m.afterTasks[0]!()).then(() => void (settled = true));
    await flush();
    expect(settled).toBe(false);
    release();
    await callback;
    expect(settled).toBe(true);
  });

  it("runs the work detached when after() throws (no request scope)", async () => {
    m.afterThrows = true;
    const fn = vi.fn(async () => {});
    expect(() => runAfterResponse(fn)).not.toThrow();
    expect(m.afterTasks).toHaveLength(0);
    await flush();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("swallows and logs a synchronous throw from the work", async () => {
    const err = new Error("boom");
    runAfterResponse(() => {
      throw err;
    });
    await expect(Promise.resolve(m.afterTasks[0]!())).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("[after-response] background task failed", err);
  });

  it("swallows and logs a rejection from the work", async () => {
    const err = new Error("rejected");
    runAfterResponse(() => Promise.reject(err));
    await expect(Promise.resolve(m.afterTasks[0]!())).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("[after-response] background task failed", err);
  });

  it("swallows and logs a rejection on the detached fallback too", async () => {
    m.afterThrows = true;
    const err = new Error("rejected detached");
    runAfterResponse(() => Promise.reject(err));
    await flush();
    expect(warn).toHaveBeenCalledWith("[after-response] background task failed", err);
  });
});

describe("flushAfterResponse (fallback path, for tests)", () => {
  beforeEach(() => {
    m.afterThrows = true;
  });

  it("resolves immediately when nothing is pending", async () => {
    await expect(flushAfterResponse()).resolves.toBeUndefined();
  });

  it("waits for work that is still running, however long it takes", async () => {
    let done = false;
    runAfterResponse(async () => {
      await new Promise((r) => setTimeout(r, 30));
      done = true;
    });
    expect(done).toBe(false);
    await flushAfterResponse();
    expect(done).toBe(true);
  });

  it("waits for tasks that schedule further tasks", async () => {
    const order: string[] = [];
    runAfterResponse(async () => {
      order.push("outer");
      await new Promise((r) => setTimeout(r, 10));
      runAfterResponse(async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push("inner");
        runAfterResponse(() => void order.push("innermost"));
      });
    });
    await flushAfterResponse();
    expect(order).toEqual(["outer", "inner", "innermost"]);
  });

  it("survives a task that throws or rejects, and still waits for the rest", async () => {
    const ran: string[] = [];
    runAfterResponse(() => {
      throw new Error("sync boom");
    });
    runAfterResponse(() => Promise.reject(new Error("async boom")));
    runAfterResponse(async () => {
      await new Promise((r) => setTimeout(r, 10));
      ran.push("after-failures");
    });
    await expect(flushAfterResponse()).resolves.toBeUndefined();
    expect(ran).toEqual(["after-failures"]);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("does not wait for work handed to the real after()", async () => {
    m.afterThrows = false;
    const fn = vi.fn();
    runAfterResponse(fn);
    await flushAfterResponse();
    expect(fn).not.toHaveBeenCalled();
  });
});
