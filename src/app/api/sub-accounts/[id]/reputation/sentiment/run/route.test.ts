import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/sub-accounts/[id]/reputation/sentiment/run — "Analyse now".
 * Admin only, both gates, a listing, once a minute; answers 202 at once and
 * classifies AFTER the response (the deferred work is captured here and
 * awaited). Real tenancy, real sync (fake GBP), real fenced AI fake.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const deferred = vi.hoisted(() => ({ work: [] as Array<() => Promise<unknown>> }));
vi.mock("@/lib/reputation/sentiment-after", async (orig) => ({
  ...(await orig<typeof import("@/lib/reputation/sentiment-after")>()),
  afterResponse: (w: () => Promise<unknown>) => void deferred.work.push(w),
}));

import { SA, asUser, mem, resetSync, reviews, seedSub } from "@/test/gbp-sync-harness";
import { syncListing } from "@/lib/gbp/sync/run";
import { fakeLogPath } from "@/lib/reputation/ai/fake";
import { sentimentLeasePath } from "@/lib/reputation/sentiment-lease";
import { POST, maxDuration } from "./route";

const ORIGINAL = { ...process.env };
const billed = () => ((mem.read(fakeLogPath(SA))?.calls ?? []) as Array<{ ids: string[] }>).flatMap((c) => c.ids);
const lease = () => mem.read(sentimentLeasePath(SA)) ?? {};

async function press(uid = "uid_admin") {
  const res = await POST(asUser(`http://127.0.0.1:3100/api/sub-accounts/${SA}/reputation/sentiment/run`, uid, "POST"), {
    params: Promise.resolve({ id: SA }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
/** Run what the route deferred until after its response. */
async function drain() {
  const work = deferred.work.splice(0);
  for (const w of work) await w();
}
function setGates(reviewsAi: boolean, google = true) {
  mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, reviewsAiEnabledByAgency: reviewsAi, googleEnabledByAgency: google });
}

beforeEach(async () => {
  resetSync();
  deferred.work.length = 0;
  process.env.REVIEWS_AI_PROVIDER = "fake";
  process.env.REVIEWS_AI_FAKE_AGENCY_ID = "ag_1";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await syncListing(SA, { trigger: "scheduled" });
  setGates(true);
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("who and when", () => {
  it.each([
    ["a collaborator", "uid_collab"],
    ["an admin of another sub-account", "uid_other_admin"],
    ["a non-member", "uid_stranger"],
  ])("refuses %s", async (_l, uid) => {
    expect((await press(uid)).status).toBe(403);
    expect(deferred.work).toHaveLength(0);
  });

  it.each([
    ["Reviews AI off", false, true, "Reviews AI is off for this sub-account"],
    ["Google off", true, false, "Google reviews are not enabled"],
  ])("refuses with gate_off when %s", async (_l, ai, google, words) => {
    setGates(ai, google);
    const { status, body } = await press();
    expect(status).toBe(403);
    expect(body.code).toBe("gate_off");
    expect(String(body.error)).toContain(words);
  });

  it("refuses without a listing", async () => {
    seedSub(SA, { listing: null });
    setGates(true);
    const { status, body } = await press();
    expect(status).toBe(409);
    expect(body.code).toBe("no_listing");
  });

  it("at most once a minute", async () => {
    expect((await press()).status).toBe(202);
    await drain();
    const again = await press();
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("too_soon");
  });

  it("busy does not burn the cooldown: once the other run finishes, a press works", async () => {
    mem.seed(sentimentLeasePath(SA), { runId: "sync-run", until: Date.now() + 60_000 });
    const busy = await press();
    expect(busy).toMatchObject({ status: 409, body: { code: "busy" } });
    expect(lease().lastManualAt).toBeUndefined();
    mem.seed(sentimentLeasePath(SA), { runId: null, until: 0 });
    expect((await press()).status).toBe(202);
  });
});

describe("the run", () => {
  it("answers 202 before classifying, then classifies after the response; a later press re-bills nothing", async () => {
    const { status, body } = await press();
    expect(status).toBe(202);
    expect(body).toEqual({ started: true, aiConfigured: true });
    expect(billed()).toEqual([]); // nothing ran inside the request
    expect(lease().runId).toEqual(expect.any(String)); // the lease is held for the deferred run
    await drain();
    expect(reviews().every((r) => r.sentiment)).toBe(true);
    expect(lease()).toMatchObject({ runId: null, lastRun: { classified: 7, skipped: 0, failed: 0 } });
    mem.seed(sentimentLeasePath(SA), { ...lease(), lastManualAt: 0 });
    await press();
    await drain();
    expect(billed()).toHaveLength(6);
  });

  it("a deferred run that finds the gate switched off ends with that reason, and releases the lease", async () => {
    expect((await press()).status).toBe(202);
    setGates(false);
    await drain();
    expect(lease()).toMatchObject({ runId: null, lastRun: { reason: "gate_off", classified: 0 } });
    expect(billed()).toEqual([]);
  });

  it("a deferred run whose first read throws still releases the lease", async () => {
    expect((await press()).status).toBe(202);
    const { storeDb } = await import("@/test/gbp-sync-store");
    const realDoc = storeDb.doc.bind(storeDb);
    vi.spyOn(storeDb, "doc").mockImplementation(((path: string) => {
      if (path === `subAccounts/${SA}`) throw new Error("14 UNAVAILABLE");
      return realDoc(path);
    }) as never);
    await expect(drain()).rejects.toThrow("14 UNAVAILABLE");
    expect(lease().runId).toBeNull();
    expect(lease().lastRun).toMatchObject({ reason: "error" }); // the card ends with "stopped on an error"
    expect(lease().lastCompleteAt).toBeUndefined();
  });
});

it("allows 300 s, so the after-response sentiment run (240 s budget) is not cut off", () => {
  expect(maxDuration).toBe(300);
});
