import { beforeEach, expect, it, vi } from "vitest";

/**
 * The daily housekeeping dispatcher runs all the jobs every time, each
 * isolated: one throwing never skips the ones after it, and never lets the
 * dispatcher answer 200 for it.
 */

const calls: string[] = [];
const jobs = vi.hoisted(() => ({
  verify: vi.fn(async (..._args: unknown[]) => true),
  heartbeat: vi.fn(async () => ({ gitpageStatus: { agency: "active" } })),
  models: vi.fn(async ({ now }: { now: number }) => ({ fetchedAt: now, models: [1, 2, 3] })),
  apiCleanup: vi.fn(async (): Promise<Record<string, unknown>> => ({ ok: true, results: [] })),
  retention: vi.fn(async () => ({ subAccounts: 2 })),
  staging: vi.fn(async () => ({ deleted: 1 })),
  usageClose: vi.fn(async () => ({ closed: 0, charged: 0, reminded: 0, failed: 0 })),
}));
vi.mock("@/lib/automations/qstash", () => ({ verifyQStashSignature: jobs.verify }));
vi.mock("@/lib/gitpage/heartbeat", () => ({
  collectHeartbeatStats: async () => ({}),
  sendHeartbeat: async () => (calls.push("gitpage-heartbeat"), jobs.heartbeat()),
}));
vi.mock("@/lib/comms/ai/model-catalog", () => ({
  refreshModelCatalog: async (o: { now: number }) => (calls.push("ai-models"), jobs.models(o)),
}));
vi.mock("../api-cleanup/route", () => ({
  runApiCleanup: async () => (calls.push("api-cleanup"), jobs.apiCleanup()),
}));
vi.mock("@/lib/gbp/sync/sweep", () => ({
  runGbpRetentionSweep: async () => (calls.push("gbp-retention"), jobs.retention()),
}));
vi.mock("@/lib/comms/whatsapp/staged-upload", () => ({
  sweepStaleStaged: async () => (calls.push("whatsapp-staging-cleanup"), jobs.staging()),
}));
vi.mock("@/lib/server/usage-billing-service", () => ({
  runUsageClose: async () => (calls.push("usage-close"), jobs.usageClose()),
}));

const { POST } = await import("./route");
const ALL = ["gitpage-heartbeat", "ai-models", "api-cleanup", "gbp-retention", "whatsapp-staging-cleanup", "usage-close"];
const run = (headers: Record<string, string> = { "upstash-signature": "sig" }) =>
  POST(new Request("https://app.example.com/api/cron/daily-housekeeping", { method: "POST", headers, body: "" }));

beforeEach(() => {
  calls.length = 0;
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.com/");
  vi.spyOn(console, "error").mockImplementation(() => {});
  jobs.heartbeat.mockClear();
  jobs.apiCleanup.mockResolvedValue({ ok: true, results: [] });
});

it("runs every job once, in order, and answers 200", async () => {
  const res = await run();
  expect(res.status).toBe(200);
  expect(calls).toEqual(ALL);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.failed).toBeUndefined();
  expect(Object.keys(body.results)).toEqual(ALL);
  expect(body.results["ai-models"]).toEqual({ ok: true, models: 3 });
});

it("keeps going past a throwing job and a failed api-cleanup, and names both in a 500", async () => {
  jobs.heartbeat.mockRejectedValueOnce(new Error("gitpage down"));
  jobs.apiCleanup.mockResolvedValue({
    ok: false,
    failures: [{ collection: "apiRequestLogs", message: "FAILED_PRECONDITION" }],
  });
  const res = await run();
  expect(calls).toEqual(ALL);
  expect(res.status).toBe(500);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.failed).toEqual([
    { job: "gitpage-heartbeat", message: "gitpage down" },
    { job: "api-cleanup", message: "sweep_failed: apiRequestLogs" },
  ]);
  expect(Object.keys(body.results)).toEqual(["ai-models", "gbp-retention", "whatsapp-staging-cleanup", "usage-close"]);
  expect(console.error).toHaveBeenCalledWith(
    "[cron/daily-housekeeping] job failed job=gitpage-heartbeat",
    expect.any(Error),
  );
});

it("a failure in the LAST job still answers 500", async () => {
  jobs.usageClose.mockRejectedValueOnce(new Error("boom"));
  const res = await run();
  expect(calls).toEqual(ALL);
  expect(res.status).toBe(500);
  expect((await res.json()).failed).toEqual([{ job: "usage-close", message: "boom" }]);
});

it("verifies the signature against its own URL and runs nothing without one", async () => {
  expect((await run({})).status).toBe(401);
  jobs.verify.mockResolvedValueOnce(false);
  expect((await run()).status).toBe(401);
  expect(calls).toEqual([]);
  await run();
  expect(jobs.verify).toHaveBeenLastCalledWith("sig", "", "https://app.example.com/api/cron/daily-housekeeping");
});
