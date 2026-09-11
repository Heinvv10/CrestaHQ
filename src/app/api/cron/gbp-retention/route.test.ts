import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/cron/gbp-retention — the daily, always-on retention housekeeping.
 * Registered unconditionally (like api-cleanup); runs a retention-only pass
 * for EVERY sub-account holding a cache — sync-eligible or not — and never
 * reaches the provider. Real signature check, real core, in-memory Firestore.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
// Wrap (not replace) the provider fence so the test can prove it is never reached.
vi.mock("@/lib/gbp/provider/select", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/gbp/provider/select")>();
  return { ...real, getGbpProviderFor: vi.fn(real.getGbpProviderFor) };
});

const KEY = "sig_test_current_key_for_gbp_retention";
process.env.QSTASH_CURRENT_SIGNING_KEY = KEY;
process.env.QSTASH_NEXT_SIGNING_KEY = "sig_test_next_key_for_gbp_retention";

import { signQStashBody } from "../../../../../e2e/lib/qstash";
import { OTHER_SA, SA, mem, resetSync, reviews, runs } from "@/test/gbp-sync-harness";
import { getGbpProviderFor } from "@/lib/gbp/provider/select";
import { syncListing } from "@/lib/gbp/sync/run";
import { POST } from "./route";

const ORIGINAL = { ...process.env };
const URL_ = "http://127.0.0.1:3100/api/cron/gbp-retention";
const DAY = 24 * 3600_000;

function cron(opts: { signature?: string | null; url?: string } = {}) {
  const body = "{}";
  const headers: Record<string, string> = {};
  const signature = opts.signature === undefined ? signQStashBody(opts.url ?? URL_, body) : opts.signature;
  if (signature !== null) headers["upstash-signature"] = signature;
  return POST(new Request(URL_, { method: "POST", headers, body }));
}

function age(sa: string, lastSuccessDaysAgo: number) {
  const sub = mem.read(`subAccounts/${sa}`)!;
  mem.seed(`subAccounts/${sa}`, {
    ...sub,
    gbpSummary: { ...(sub.gbpSummary as object), lastSuccessfulSyncAt: new Date(Date.now() - lastSuccessDaysAgo * DAY) },
  });
}

beforeEach(async () => {
  resetSync();
  process.env.QSTASH_CURRENT_SIGNING_KEY = KEY;
  delete process.env.GBP_SYNC_SCHEDULE_ENABLED; // the default: sync schedule OFF
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await syncListing(SA, { trigger: "manual" }); // a cache on a sync-ELIGIBLE tenant
  vi.mocked(getGbpProviderFor).mockClear();
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("signature", () => {
  it("401s an unsigned call", async () => {
    expect((await cron({ signature: null })).status).toBe(401);
  });

  it("401s a genuine signature minted for another route (replay)", async () => {
    expect((await cron({ url: "http://127.0.0.1:3100/api/cron/gbp-sync" })).status).toBe(401);
  });
});

describe("always-on retention, with the sync schedule OFF", () => {
  it("the reviewer's case: a 31-day-old cache on a sync-eligible tenant is purged — without reaching Google", async () => {
    age(SA, 31);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await cron();
    vi.unstubAllGlobals();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ retained: 1 });
    expect(reviews(SA)).toHaveLength(0);
    expect(mem.read(`subAccounts/${SA}`)?.gbpSummary).toMatchObject({
      averageRating: null, totalReviewCount: null, lastErrorKind: "retention_expired",
    });
    expect(runs(SA).find((r) => r.skipReason === "retention_only")).toMatchObject({ status: "skipped", purged: 7 });
    expect(getGbpProviderFor).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("within 30 days: only a review not re-seen for 30 days goes; the summary is untouched", async () => {
    const first = reviews(SA)[0];
    mem.seed(`subAccounts/${SA}/gbpReviews/${first.id}`, { ...first, lastSeenAt: new Date(Date.now() - 31 * DAY) });
    const before = mem.read(`subAccounts/${SA}`)?.gbpSummary;
    await cron();
    expect(reviews(SA)).toHaveLength(6);
    expect(mem.read(`subAccounts/${SA}`)?.gbpSummary).toEqual(before);
    expect(getGbpProviderFor).not.toHaveBeenCalled();
  });

  it("touches only tenants that hold a cache", async () => {
    expect(await (await cron()).json()).toMatchObject({ retained: 1 });
    expect(runs(OTHER_SA)).toHaveLength(0);
  });

  it("500s — so QStash retries — when the sweep cannot start", async () => {
    delete process.env.GBP_FAKE_AGENCY_ID;
    const res = await cron();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "sweep_failed" });
  });
});
