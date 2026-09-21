import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { createByteBudget, stagedMediaBudget } from "./media-budget";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createByteBudget", () => {
  it("grants within the total at once and counts what it granted", async () => {
    const b = createByteBudget(100, 1_000);
    const r1 = await b.acquire(60);
    const r2 = await b.acquire(40);
    expect(r1).toBeTypeOf("function");
    expect(r2).toBeTypeOf("function");
    expect(b.inFlight()).toBe(100);
  });

  it("makes a request that does not fit wait, and grants it when budget is released", async () => {
    const b = createByteBudget(100, 1_000);
    const r1 = (await b.acquire(80))!;
    let granted = false;
    const p = b.acquire(50).then((r) => ((granted = r !== null), r));
    await vi.advanceTimersByTimeAsync(500);
    expect(granted).toBe(false);
    expect(b.inFlight()).toBe(80);
    r1();
    const r2 = await p;
    expect(r2).toBeTypeOf("function");
    // Never both at once.
    expect(b.inFlight()).toBe(50);
  });

  it("refuses with null when nothing is released within the wait, and forgets the waiter", async () => {
    const b = createByteBudget(100, 1_000);
    const r1 = (await b.acquire(80))!;
    const p = b.acquire(50);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await p).toBeNull();
    r1();
    expect(b.inFlight()).toBe(0);
  });

  it("is FIFO: a waiting large request is not overtaken by a later small one", async () => {
    const b = createByteBudget(100, 1_000);
    const r1 = (await b.acquire(60))!;
    const order: string[] = [];
    const big = b.acquire(90).then((r) => (order.push("big"), r));
    const small = b.acquire(10).then((r) => (order.push("small"), r));
    await vi.advanceTimersByTimeAsync(10);
    expect(order).toEqual([]);
    r1();
    const rb = (await big)!;
    rb();
    await small;
    expect(order).toEqual(["big", "small"]);
  });

  it("refuses at once a request larger than the whole budget", async () => {
    expect(await createByteBudget(100, 1_000).acquire(101)).toBeNull();
  });

  it("ignores a second release of the same grant", async () => {
    const b = createByteBudget(100, 1_000);
    const r = (await b.acquire(70))!;
    r();
    r();
    expect(b.inFlight()).toBe(0);
    await b.acquire(100);
    expect(b.inFlight()).toBe(100);
  });
});

it("the shared budget admits two maximum-size Cloud documents at once, not three", async () => {
  const a = await stagedMediaBudget.acquire(100_000_000);
  const b = await stagedMediaBudget.acquire(100_000_000);
  const c = stagedMediaBudget.acquire(100_000_000);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(a).toBeTypeOf("function");
  expect(b).toBeTypeOf("function");
  expect(await c).toBeNull();
  a!();
  b!();
});
