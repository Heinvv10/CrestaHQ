import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Each sweep is isolated: one collection-group query failing (a missing
 * index answers FAILED_PRECONDITION) must not skip the others — above all the
 * POPIA review-feedback PII scrub and the watchdog sweep. The failure still
 * surfaces as a 500 naming the sweep.
 */

const publishCallback = vi.hoisted(() =>
  vi.fn(async (): Promise<{ messageId: string } | null> => ({ messageId: "m1" })),
);
vi.mock("@/lib/automations/qstash", () => ({
  verifyQStashSignature: async () => true,
  publishCallback,
}));
/** Which sweeps fail / come back full (500 docs = hit the per-run cap). */
const setup = vi.hoisted(() => ({ failing: new Set<string>(), capped: new Set<string>() }));
const sweepOldWatchdogRuns = vi.hoisted(() => vi.fn(async () => 2));
vi.mock("@/lib/server/agents-watchdog-service", () => ({ sweepOldWatchdogRuns }));

const scrubbed: Array<Record<string, unknown>> = [];
const emptyQuery = { where: () => emptyQuery, limit: () => emptyQuery, get: async () => ({ empty: true, docs: [], size: 0 }) };
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    collectionGroup: (name: string) => {
      if (setup.failing.has(name)) {
        const failing = {
          where: () => failing,
          limit: () => failing,
          get: async () => {
            throw Object.assign(new Error("9 FAILED_PRECONDITION: The query requires an index."), { code: 9 });
          },
        };
        return failing;
      }
      if (setup.capped.has(name)) {
        const docs = Array.from({ length: 500 }, (_, i) => ({ ref: { id: `d${i}` } }));
        const full = { where: () => full, limit: () => full, get: async () => ({ empty: false, docs, size: 500 }) };
        return full;
      }
      return emptyQuery;
    },
    collection: () => {
      const q = {
        where: () => q,
        limit: () => q,
        get: async () => ({ empty: false, size: 1, docs: [{ ref: { id: "fb1" } }] }),
      };
      return q;
    },
    batch: () => ({
      update: (_ref: unknown, data: Record<string, unknown>) => scrubbed.push(data),
      delete: () => {},
      commit: async () => {},
    }),
  }),
}));

const { POST } = await import("./route");

const run = () =>
  POST(new Request("https://app.test/api/cron/api-cleanup", {
    method: "POST",
    headers: { "upstash-signature": "sig" },
    body: "{}",
  }));

beforeEach(() => {
  setup.failing = new Set(["apiRequestLogs"]);
  setup.capped = new Set();
  publishCallback.mockClear();
  scrubbed.length = 0;
  sweepOldWatchdogRuns.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/cron/api-cleanup — sweep isolation", () => {
  it("a sweep failing FAILED_PRECONDITION still lets the PII scrub and the watchdog sweep run, and reports the failure", async () => {
    const res = await run();
    expect(scrubbed).toEqual([{ submittedFromIp: null, submittedUserAgent: null, piiExpiresAt: null }]);
    expect(sweepOldWatchdogRuns).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; failures: Array<{ collection: string }>; results: Array<{ collection: string }> };
    expect(body.ok).toBe(false);
    expect(body.failures.map((f) => f.collection)).toEqual(["apiRequestLogs"]);
    expect(body.results.map((r) => r.collection)).toEqual(
      expect.arrayContaining(["apiIdempotency", "webhookEvents", "communityMagicLinkUses", "reviewFeedback/pii", "customAgents/runs"]),
    );
  });

  it("does not schedule a continuation on a partial failure, even when another sweep hit the cap", async () => {
    setup.capped = new Set(["apiIdempotency"]);
    const res = await run();
    expect(res.status).toBe(500);
    expect(((await res.json()) as { continuationScheduled: boolean }).continuationScheduled).toBe(false);
    expect(publishCallback).not.toHaveBeenCalled();
  });

  it("still schedules one when every sweep succeeded and one hit the cap", async () => {
    setup.failing = new Set();
    setup.capped = new Set(["apiIdempotency"]);
    const res = await run();
    expect(res.status).toBe(200);
    expect(publishCallback).toHaveBeenCalledTimes(1);
    expect(((await res.json()) as { continuationScheduled: boolean }).continuationScheduled).toBe(true);
  });

  it("reports continuationScheduled false and logs when the continuation publish resolves null", async () => {
    setup.failing = new Set();
    setup.capped = new Set(["apiIdempotency"]);
    publishCallback.mockResolvedValueOnce(null);
    const res = await run();
    expect(res.status).toBe(200);
    expect(publishCallback).toHaveBeenCalledTimes(1);
    expect(((await res.json()) as { continuationScheduled: boolean }).continuationScheduled).toBe(false);
    expect(console.error).toHaveBeenCalledWith("[cron/api-cleanup] continuation not queued");
  });
});
