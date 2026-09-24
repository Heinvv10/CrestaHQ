import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * publishCallback never throws — it resolves null when the next step could
 * not be queued. The drain must then fail the job visibly (status + the
 * reason first in its error list), not leave it "running" forever.
 */

const publishCallback = vi.hoisted(() =>
  vi.fn(async (): Promise<{ messageId: string } | null> => ({ messageId: "m1" })),
);
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  verifyQStashSignature: async () => true,
  publishCallback,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/sub-account-secrets", () => ({
  readSubAccountSecret: async () => "tok",
}));
vi.mock("@/lib/import/bulk-write", () => ({
  writeImportChunk: async () => ({
    received: 0, created: 0, updated: 0, skipped: 0, failed: 0, errors: [],
  }),
}));
vi.mock("@/lib/import/job-progress", () => ({ applyChunkResultToJob: async () => {} }));
const page = vi.hoisted(() => ({ next: null as null | { startAfterId: string } }));
vi.mock("@/lib/import/ghl/client", () => ({
  GhlApiError: class extends Error {},
  listContactsPage: async () => ({ items: [], next: page.next }),
  listOpportunitiesPage: async () => ({ items: [], next: null }),
  listContactNotes: async () => [],
}));

const jobUpdates: Array<Record<string, unknown>> = [];
const jobData = {
  subAccountId: "sa1",
  agencyId: "ag1",
  createdByUid: "u1",
  status: "running",
  errors: [{ entity: "contacts", externalId: "c9", error: "bad email" }],
  ghlEntities: ["contacts", "opportunities"],
};
vi.mock("@/lib/firebase/admin", () => ({
  getAdminDb: () => ({
    doc: (path: string) =>
      path.startsWith("importJobs/")
        ? {
            get: async () => ({ exists: true, data: () => jobData }),
            update: async (d: Record<string, unknown>) => void jobUpdates.push(d),
          }
        : {
            get: async () => ({ data: () => ({ ghlImportConfig: { locationId: "loc1" } }) }),
          },
    runTransaction: async (fn: (tx: unknown) => Promise<void>) =>
      fn({
        get: async () => ({ exists: true, data: () => jobData }),
        update: (_ref: unknown, d: Record<string, unknown>) => void jobUpdates.push(d),
      }),
  }),
}));

const { POST } = await import("./route");

const step = () =>
  POST(
    new Request("https://app.test/api/import/ghl/step", {
      method: "POST",
      headers: { "upstash-signature": "sig" },
      body: JSON.stringify({ jobId: "job1", subAccountId: "sa1", entity: "contacts" }),
    }),
  );

beforeEach(() => {
  jobUpdates.length = 0;
  page.next = null;
  publishCallback.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/import/ghl/step — next step not queued", () => {
  it("fails the job with the reason first when the next-entity publish resolves null", async () => {
    publishCallback.mockResolvedValueOnce(null);
    const res = await step();
    expect(((await res.json()) as { stopped?: string }).stopped).toBe("unscheduled");
    expect(jobUpdates).toHaveLength(1);
    const u = jobUpdates[0] as { status: string; errors: Array<{ entity: string; error: string }> };
    expect(u.status).toBe("failed");
    expect(u.errors[0]?.entity).toBe("deals");
    expect(u.errors[0]?.error).toMatch(/Could not schedule the next import step/);
    expect(u.errors[1]).toEqual(jobData.errors[0]);
    expect(console.error).toHaveBeenCalledWith(
      "[import/ghl/step] next step not queued job=job1 entity=opportunities",
    );
  });

  it("fails the job when the next-page publish resolves null", async () => {
    page.next = { startAfterId: "c50" };
    publishCallback.mockResolvedValueOnce(null);
    await step();
    expect((jobUpdates[0] as { status: string }).status).toBe("failed");
    expect(console.error).toHaveBeenCalledWith(
      "[import/ghl/step] next step not queued job=job1 entity=contacts",
    );
  });

  it("leaves the job running when the next step is queued", async () => {
    const res = await step();
    expect(await res.json()).toEqual({ ok: true });
    expect(publishCallback).toHaveBeenCalledTimes(1);
    expect(jobUpdates).toEqual([]);
  });
});
