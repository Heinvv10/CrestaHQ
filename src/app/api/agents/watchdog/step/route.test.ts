import { beforeEach, expect, it, vi } from "vitest";

/**
 * The hourly step runs the inbox watchdog FIRST and the stale deals monitor
 * after it, and a stale-deals failure never fails the watchdog's response.
 * The two sweeps are stubbed; the order and the isolation are the contract.
 */

const s = vi.hoisted(() => ({
  calls: [] as string[],
  staleThrows: false,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/automations/qstash", () => ({ verifyQStashSignature: async () => true }));
vi.mock("@/lib/server/agents-watchdog-service", () => ({
  runWatchdogSweep: async () => {
    s.calls.push("watchdog");
    return { agents: 1, results: [{ subAccountId: "sa1", status: "completed" }] };
  },
}));
vi.mock("@/lib/server/agents-stale-deals-service", () => ({
  runStaleDealsSweep: async () => {
    s.calls.push("stale-deals");
    if (s.staleThrows) throw new Error("boom");
    return { agents: 1, results: [] };
  },
}));

const { POST } = await import("./route");
const call = () =>
  POST(new Request("https://app.test/api/agents/watchdog/step", { method: "POST", headers: { "upstash-signature": "sig" }, body: "{}" }));

beforeEach(() => {
  s.calls = [];
  s.staleThrows = false;
});

it("runs the watchdog before stale deals", async () => {
  const res = await call();
  expect(res.status).toBe(200);
  expect(s.calls).toEqual(["watchdog", "stale-deals"]);
});

it("a stale-deals failure still returns the watchdog's results", async () => {
  s.staleThrows = true;
  const res = await call();
  expect(res.status).toBe(200);
  const body = (await res.json()) as { results: unknown[]; staleDeals: unknown };
  expect(body.results).toHaveLength(1);
  expect(body.staleDeals).toEqual({ error: "sweep_failed" });
});
