import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryFirestore } from "@/test/memory-firestore";

/**
 * transitionWebsite is the one way a website doc's build state is written.
 * Its whole job is to refuse a write whose author acted on a doc that has
 * since changed: another job, or a status it may not move the site from.
 * Real helper over the in-memory Firestore, whose transactions re-run when
 * a doc they read changes before they commit, as Firestore's do.
 */

const mem = createMemoryFirestore();
vi.mock("@/lib/firebase/admin", () => ({ getAdminDb: () => mem.db }));
vi.mock("@/lib/automations/qstash", () => ({
  qstashIsConfigured: () => true,
  publishCallback: async () => ({ messageId: "m1" }),
}));
vi.mock("@/lib/gitpage/heartbeat", () => ({
  markGitpageBuildSucceeded: async () => {},
  markGitpageKeyInvalid: async () => {},
}));

const { transitionWebsite, WEBSITE_IN_FLIGHT } = await import("./websites-service");

const SITE = "subAccounts/sa1/website/site1";
const ref = () => mem.db.doc(SITE) as unknown as FirebaseFirestore.DocumentReference;
const seed = (patch: Record<string, unknown> = {}) =>
  mem.seed(SITE, { id: "site1", subAccountId: "sa1", status: "building", gitpageJobId: "job_a", pollAttempts: 3, ...patch });

beforeEach(() => {
  mem.clear();
  seed();
});

describe("transitionWebsite", () => {
  it("writes when the doc still carries the job and is in an allowed status", async () => {
    const res = await transitionWebsite(ref(), { expectJobId: "job_a", fromStatuses: WEBSITE_IN_FLIGHT }, { pollAttempts: 4 });
    expect(res).toEqual({ applied: true });
    expect(mem.read(SITE)).toMatchObject({ status: "building", gitpageJobId: "job_a", pollAttempts: 4 });
  });

  it("refuses a write for a job the doc no longer carries", async () => {
    seed({ gitpageJobId: "job_b", status: "queued", pollAttempts: 0 });
    const before = mem.read(SITE);
    const res = await transitionWebsite(
      ref(),
      { expectJobId: "job_a", fromStatuses: WEBSITE_IN_FLIGHT },
      { status: "failed", errorMessage: "timeout" },
    );
    expect(res).toEqual({ applied: false, reason: "job" });
    expect(mem.read(SITE)).toEqual(before);
  });

  it("refuses a write for a job once the doc has none (a reset)", async () => {
    seed({ gitpageJobId: null, status: "draft" });
    const before = mem.read(SITE);
    const res = await transitionWebsite(ref(), { expectJobId: "job_a", fromStatuses: WEBSITE_IN_FLIGHT }, { status: "building" });
    expect(res).toEqual({ applied: false, reason: "job" });
    expect(mem.read(SITE)).toEqual(before);
  });

  it.each(["ready", "failed", "draft"])("refuses an in-flight write over a %s doc, same job or not", async (status) => {
    seed({ status });
    const before = mem.read(SITE);
    for (const patch of [{ status: "failed", errorMessage: "gitpage rejected the poll" }, { status: "building", pollAttempts: 9 }]) {
      const res = await transitionWebsite(ref(), { expectJobId: "job_a", fromStatuses: WEBSITE_IN_FLIGHT }, patch);
      expect(res).toEqual({ applied: false, reason: "status" });
    }
    expect(mem.read(SITE)).toEqual(before);
  });

  it("applies the caller's own condition to the doc as the transaction reads it", async () => {
    const when = (fresh: { pollAttempts?: number | null }) => (fresh.pollAttempts ?? 0) < 3;
    const res = await transitionWebsite(ref(), { fromStatuses: WEBSITE_IN_FLIGHT, when }, { pollAttempts: 99 });
    expect(res).toEqual({ applied: false, reason: "condition" });
    expect(mem.read(SITE)).toMatchObject({ pollAttempts: 3 });
  });

  it("does not create a missing doc unless the writer says it may", async () => {
    mem.clear();
    const res = await transitionWebsite(ref(), { fromStatuses: WEBSITE_IN_FLIGHT }, { status: "failed" });
    expect(res).toEqual({ applied: false, reason: "missing" });
    expect(mem.read(SITE)).toBeUndefined();

    const created = await transitionWebsite(ref(), { fromStatuses: ["draft"], orMissing: true }, { status: "queued", gitpageJobId: "job_a" });
    expect(created).toEqual({ applied: true });
    expect(mem.read(SITE)).toMatchObject({ status: "queued", gitpageJobId: "job_a" });
  });

  it("of two writers that both read the doc in flight, only the first applies", async () => {
    const guard = { expectJobId: "job_a", fromStatuses: WEBSITE_IN_FLIGHT };
    const results = await Promise.all([
      transitionWebsite(ref(), guard, { status: "ready", liveUrl: "https://a.example/" }),
      transitionWebsite(ref(), guard, { status: "failed", errorMessage: "timeout" }),
    ]);
    expect(results.filter((r) => r.applied)).toHaveLength(1);
    const doc = mem.read(SITE)!;
    // Whichever won, the doc is one writer's state, never a blend of both.
    if (doc.status === "ready") expect(doc.errorMessage).toBeUndefined();
    else expect(doc.liveUrl).toBeUndefined();
  });

  it("re-reads when the doc changes between its read and its commit", async () => {
    const runTransaction = mem.db.runTransaction;
    let raced = false;
    const spy = vi.spyOn(mem.db, "runTransaction").mockImplementation((fn) =>
      runTransaction(async (tx) => {
        const out = await fn(tx);
        if (!raced) {
          raced = true;
          await mem.db.doc(SITE).update({ status: "ready", liveUrl: "https://a.example/" });
        }
        return out;
      }),
    );
    const res = await transitionWebsite(
      ref(),
      { expectJobId: "job_a", fromStatuses: WEBSITE_IN_FLIGHT },
      { status: "failed", errorMessage: "timeout" },
    );
    spy.mockRestore();
    expect(res).toEqual({ applied: false, reason: "status" });
    expect(mem.read(SITE)).toMatchObject({ status: "ready", liveUrl: "https://a.example/" });
    expect(mem.read(SITE)?.errorMessage).toBeUndefined();
  });
});
