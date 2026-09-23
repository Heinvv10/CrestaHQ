import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Each sweep is isolated: one collection-group query failing (a missing
 * index answers FAILED_PRECONDITION) must not skip the others — above all the
 * POPIA review-feedback PII scrub and the watchdog sweep. The failure still
 * surfaces as a 500 naming the sweep.
 */

vi.mock("@/lib/automations/qstash", () => ({
  verifyQStashSignature: async () => true,
  publishCallback: vi.fn(async () => {}),
}));
const sweepOldWatchdogRuns = vi.hoisted(() => vi.fn(async () => 2));
vi.mock("@/lib/server/agents-watchdog-service", () => ({ sweepOldWatchdogRuns }));

const scrubbed: Array<Record<string, unknown>> = [];
const emptyQuery = { where: () => emptyQuery, limit: () => emptyQuery, get: async () => ({ empty: true, docs: [], size: 0 }) };
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    collectionGroup: (name: string) => {
      if (name === "apiRequestLogs") {
        const failing = {
          where: () => failing,
          limit: () => failing,
          get: async () => {
            throw Object.assign(new Error("9 FAILED_PRECONDITION: The query requires an index."), { code: 9 });
          },
        };
        return failing;
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

beforeEach(() => {
  scrubbed.length = 0;
  sweepOldWatchdogRuns.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/cron/api-cleanup — sweep isolation", () => {
  it("a sweep failing FAILED_PRECONDITION still lets the PII scrub and the watchdog sweep run, and reports the failure", async () => {
    const res = await POST(new Request("https://app.test/api/cron/api-cleanup", {
      method: "POST",
      headers: { "upstash-signature": "sig" },
      body: "{}",
    }));
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
});
