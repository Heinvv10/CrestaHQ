import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The public feed's freshness honesty and its leak-proofing:
 *   - stale data is served LABELLED (12h old, reconnect needed, partial, a
 *     failing Google) — never presented as live;
 *   - nothing is served once it is 7 days old, never synced, or past the
 *     30-day content rule for a single review;
 *   - no internal field ever reaches the public body.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { LOC_A, SA, mem, recordingSleep, resetSync, setScenario } from "@/test/gbp-sync-harness";
import { ageLastSuccess, createWidget, feedBody, freshIp, patchSummary } from "@/test/gbp-feed-harness";
import { syncListing } from "@/lib/gbp/sync/run";

const ORIGINAL = { ...process.env };
let ip: string;
let id: string;
const read = () => feedBody(id, { "x-forwarded-for": ip });

beforeEach(async () => {
  resetSync();
  ip = freshIp();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await syncListing(SA, { trigger: "scheduled" });
  id = await createWidget();
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("stale: served, but labelled", () => {
  it("is ok at 11h and stale at 13h since the last success", async () => {
    ageLastSuccess(11);
    expect(await read()).toMatchObject({ status: "ok", freshness: { stale: false } });
    ageLastSuccess(13);
    const body = await read();
    expect(body).toMatchObject({ status: "stale", freshness: { stale: true }, rating: { average: 3.6, count: 7 } });
    expect(body.reviews).toHaveLength(7);
  });

  it("is stale while the grant is revoked, with every cached review still served", async () => {
    setScenario(SA, (s) => void (s.revoked = true));
    const run = await syncListing(SA, { trigger: "scheduled" });
    expect(run.status).toBe("reconnect_required");
    const body = await read();
    expect(body).toMatchObject({ status: "stale", freshness: { stale: true }, rating: { average: 3.6, count: 7 } });
    expect(body.reviews).toHaveLength(7);
  });

  it("is stale when the live connection is flagged, even if the last run succeeded", async () => {
    const sub = mem.read(`subAccounts/${SA}`)!;
    mem.seed(`subAccounts/${SA}`, {
      ...sub,
      googleConnectionMeta: { ...(sub.googleConnectionMeta as object), reconnectRequired: true, reconnectReason: "revoked" },
    });
    expect(await read()).toMatchObject({ status: "stale", freshness: { stale: true } });
  });

  it("is stale after a partial run", async () => {
    patchSummary({ lastRunStatus: "partial", lastReconciliation: "deferred" });
    expect(await read()).toMatchObject({ status: "stale", freshness: { stale: true } });
  });

  it("a Google outage serves the last good cache labelled stale — nothing fabricated", async () => {
    const before = await read();
    setScenario(SA, (s) => void (s.failReviewsPage = { pageToken: null, kind: "transient" }));
    const run = await syncListing(SA, { trigger: "scheduled", sleep: recordingSleep().sleep });
    expect(run.status).toBe("failed");
    const after = await read();
    expect(after).toMatchObject({
      status: "stale",
      freshness: { stale: true, lastSuccessfulSyncAt: before.freshness.lastSuccessfulSyncAt },
      rating: before.rating,
    });
    expect(after.reviews).toEqual(before.reviews);
  });
});

describe("unavailable: nothing served", () => {
  const unavailable = { status: "unavailable", rating: null, reviews: [], freshness: { stale: true } };

  it("once the last success is more than 7 days old", async () => {
    ageLastSuccess(7 * 24 - 1);
    expect((await read()).status).toBe("stale");
    ageLastSuccess(7 * 24 + 1);
    const body = await read();
    expect(body).toMatchObject(unavailable);
    // Still says when it last worked, and still names the listing.
    expect(body.freshness.lastSuccessfulSyncAt).not.toBeNull();
    expect(body.listing?.title).toBe("Velo Test Fibre — Gqeberha");
  });

  it("when the listing has never synced successfully", async () => {
    const other = await createWidget({ enabled: true, allowedOrigins: [] }, "sa_2", "uid_other_admin");
    const body = await feedBody(other, { "x-forwarded-for": ip });
    expect(body).toMatchObject({ ...unavailable, freshness: { lastSuccessfulSyncAt: null, stale: true } });
  });

  it("when the summary belongs to a different listing than the one selected now", async () => {
    patchSummary({ locationName: "locations/previous" });
    expect(await read()).toMatchObject(unavailable);
  });

  it("never serves a single review past Google's 30-day rule (the sync's own read-time predicate)", async () => {
    const docs = mem.list(`subAccounts/${SA}/gbpReviews`);
    const aged = docs[0];
    mem.seed(`subAccounts/${SA}/gbpReviews/${aged.id}`, { ...aged, lastSeenAt: new Date(Date.now() - 31 * 24 * 3600_000) });
    const ids = (await read()).reviews.map((r) => r.id);
    expect(ids).toHaveLength(6);
    expect(ids).not.toContain(aged.id);
  });
});

describe("leakage: an explicit allow-list, never a spread", () => {
  it("serves no photo for an anonymous reviewer, even if one is stored", async () => {
    const d = mem.list(`subAccounts/${SA}/gbpReviews`)[0];
    mem.seed(`subAccounts/${SA}/gbpReviews/${d.id}`, {
      ...d, reviewer: { displayName: "", profilePhotoUrl: "https://lh3.googleusercontent.com/a/anon", isAnonymous: true },
    });
    const served = (await read()).reviews.find((r) => r.id === d.id)!;
    expect(served.author).toEqual({ name: "", photoUrl: null, anonymous: true });
  });

  it("serves none of the internal fields, whatever the stored docs carry", async () => {
    // Replace the cache with ONE review stuffed with every internal field.
    for (const d of mem.list(`subAccounts/${SA}/gbpReviews`)) mem.seed(`subAccounts/${SA}/gbpReviews/${d.id}`, { state: "removed" });
    mem.seed(`subAccounts/${SA}/gbpReviews/pub1`, {
      agencyId: "ag_1", subAccountId: SA, createdByUid: "uid_admin", locationName: LOC_A,
      reviewName: "accounts/123/locations/456/reviews/789", reviewId: "fake-review-789",
      reviewer: { displayName: "Pat", profilePhotoUrl: "https://lh3.googleusercontent.com/a/pat", isAnonymous: false, email: "pat@example.com", uid: "uid_x" },
      starRating: 2, comment: "Plain words.", createTime: new Date("2026-09-01T00:00:00Z"), updateTime: new Date("2026-09-02T00:00:00Z"),
      reply: { comment: "Sorry, Pat.", updateTime: "2026-09-03T00:00:00Z", authorEmail: "owner@example.com", token: "reply-SECRET" },
      state: "active", firstSeenAt: new Date(), lastSeenAt: new Date(), removedAt: null,
      passId: "pass-SECRET", contentHash: "hash-SECRET", accessToken: "stored-access-SECRET", refreshToken: "stored-refresh-SECRET",
      errorKind: "internal-SECRET", placeId: "ChIJ-SECRET",
    });
    const sub = mem.read(`subAccounts/${SA}`)!;
    mem.seed(`subAccounts/${SA}`, {
      ...sub,
      googleListing: {
        ...(sub.googleListing as object), placeId: "ChIJ-SECRET", accountName: "accounts/123", selectedByUid: "uid_admin",
        // Google's real write-review link carries the Place ID in its query — served as-is, it is Google's public link.
        newReviewUri: "https://search.google.com/local/writereview?placeid=ChIJfixture0000000000",
      },
      gbpSummary: { ...(sub.gbpSummary as object), lastErrorKind: "internal-SECRET", lastReconciliation: "full" },
      googleConnectionMeta: { ...(sub.googleConnectionMeta as object), email: "owner@example.com" },
    });

    const body = await read();
    expect(body.reviews).toEqual([
      {
        id: "pub1",
        author: { name: "Pat", photoUrl: "https://lh3.googleusercontent.com/a/pat", anonymous: false },
        rating: 2,
        text: "Plain words.",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-02T00:00:00.000Z",
        reply: { text: "Sorry, Pat.", updatedAt: "2026-09-03T00:00:00.000Z" },
      },
    ]);
    expect(body.listing?.writeReviewUri).toBe("https://search.google.com/local/writereview?placeid=ChIJfixture0000000000");
    // Everything but that one public Google link is scanned.
    const text = JSON.stringify({ ...body, listing: { ...body.listing, writeReviewUri: null } });
    for (const marker of [
      "accounts/", "locations/", SA, "ag_1", "@", "fake-", "token", "uid_", "SECRET", "ChIJ", "passId", "contentHash",
      "reviewName", "placeId", "errorKind", "lease", "pageToken",
    ]) {
      expect(text, marker).not.toContain(marker);
    }
    expect(Object.keys(body).sort()).toEqual(["display", "freshness", "listing", "rating", "reviews", "source", "status", "version"]);
  });
});
