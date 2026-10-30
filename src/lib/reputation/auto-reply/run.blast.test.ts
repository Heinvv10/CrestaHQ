import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Blast-radius regression guards (PR #291 breaker): with CI's E2E env (kill
 * switch on, GBP + Reviews AI fakes fenced to the fixture agency) — and with
 * a mixed dev env (GBP real, AI fake) — nothing of a NON-fixture tenant is
 * changed, drafted or posted by review auto-reply. The foreign tenant is
 * Velocity-like: same location name as the fixture, gates on, auto-reply on,
 * a queued draft in its cache.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { FOREIGN_AGENCY, FOREIGN_SA, SA, mem, seedSub, setScenario } from "@/test/gbp-sync-harness";
import { calls, docIdOf } from "@/test/gbp-reply-harness";
import { resetAutoReply } from "@/test/auto-reply-harness";
import { runAfterSync } from "@/lib/reputation/after-sync";
import { runGbpSyncSweep } from "@/lib/gbp/sync/sweep";
import { syncListing } from "@/lib/gbp/sync/run";
import { reviewBasis } from "@/lib/reputation/sentiment-basis";
import { autoReplyLeasePath } from "./store";
import { autoReplyAfterSync } from "./run";

const ORIGINAL = { ...process.env };
const foreignDump = () => JSON.stringify(mem.all().filter((d) => d.path.startsWith(`subAccounts/${FOREIGN_SA}`)));

function seedForeign() {
  seedSub(FOREIGN_SA, { agencyId: FOREIGN_AGENCY });
  const sub = mem.read(`subAccounts/${FOREIGN_SA}`)!;
  const listing = (sub.googleListing as { locationName: string }).locationName;
  mem.seed(`subAccounts/${FOREIGN_SA}`, {
    ...sub, reviewsAiEnabledByAgency: true, reviewsAutoReplyEnabledByAgency: true,
    gbpSummary: { lastRunAt: new Date(0), locationName: listing },
    reviewsAutoReply: {
      enabled: true, modes: { 1: "auto", 2: "auto", 3: "auto", 4: "auto", 5: "auto" }, includeBacklog: true,
      enabledAt: new Date(0), enabledByUid: "uid_real", listingLocationName: listing, updatedAt: new Date(0), updatedByUid: "uid_real",
    },
  });
  const review = {
    reviewName: `accounts/x/${listing}/reviews/real1`, reviewId: "real1", state: "active", locationName: listing,
    starRating: 5, comment: null, createTime: new Date(), lastSeenAt: new Date(), reply: null,
  };
  mem.seed(`subAccounts/${FOREIGN_SA}/gbpReviews/${docIdOf("real1")}`, {
    ...review,
    pendingReply: { text: "queued", textHash: "h", basisHash: reviewBasis(review as never), reason: "auto_queued", at: new Date(), model: "m" },
  });
  mem.seed(`subAccounts/${FOREIGN_SA}/gbpReviews/${docIdOf("real2")}`, {
    ...review, reviewName: review.reviewName.replace("real1", "real2"), reviewId: "real2",
  });
  setScenario(FOREIGN_SA, () => {}); // a scenario doc exists, so a putReply would be visible
}

beforeEach(() => {
  resetAutoReply();
  seedForeign();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

const runOf = (sa: string) => ({ subAccountId: sa, created: 1, updated: 0, startedAt: new Date(0) });

describe("CI env: a non-fixture tenant is never changed, drafted or posted for", () => {
  it("the engine alone, handed a foreign tenant, changes nothing of it", async () => {
    const before = foreignDump();
    expect(await autoReplyAfterSync(FOREIGN_SA, new Date(0), Date.now() + 60_000)).toBeNull();
    expect(foreignDump()).toBe(before);
    expect(calls(FOREIGN_SA)).toEqual([]);
  });

  it("the cron sweep never produces a foreign run, and the fixture's after-sync leaves it alone", async () => {
    const before = foreignDump();
    const runs: Parameters<typeof runAfterSync>[0] = [];
    await runGbpSyncSweep({ onRun: (r) => runs.push({ subAccountId: r.subAccountId, created: r.created, updated: r.updated, startedAt: r.startedAt }) });
    expect(runs.map((r) => r.subAccountId)).not.toContain(FOREIGN_SA);
    await runAfterSync(runs, Date.now() + 60_000);
    expect(foreignDump()).toBe(before);
  });

  it("Sync now for the foreign tenant throws before any write", async () => {
    const before = foreignDump();
    await expect(syncListing(FOREIGN_SA, { trigger: "manual", actorUid: "uid_real" })).rejects.toThrow();
    expect(foreignDump()).toBe(before);
  });

  it("a fake requested but REFUSED (non-loopback URL): the engine is inert for the fixture and the foreign tenant", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://crm.crestahq.com";
    const before = foreignDump();
    await runAfterSync([runOf(FOREIGN_SA), runOf(SA)], Date.now() + 60_000);
    expect(foreignDump()).toBe(before);
    expect(mem.read(autoReplyLeasePath(SA))).toBeUndefined();
  });
});

describe("mixed dev env (GBP real, Reviews AI fake, kill switch on)", () => {
  it("the Reviews AI fake's fence alone keeps the engine off a real tenant — not even the lease", async () => {
    delete process.env.GBP_PROVIDER;
    const before = foreignDump();
    expect(await autoReplyAfterSync(FOREIGN_SA, new Date(0), Date.now() + 60_000)).toBeNull();
    expect(foreignDump()).toBe(before);
    expect(mem.read(autoReplyLeasePath(FOREIGN_SA))).toBeUndefined();
  });
});
