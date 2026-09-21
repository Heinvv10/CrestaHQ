import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/sub-accounts/[id]/gbp/reviews — the cached reviews, the summary
 * with freshly derived health, and the last runs. Any active member may read
 * (collaborators included); nothing internal leaves the server.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import {
  LEAK_MARKERS,
  LOC_A,
  SA,
  asUser,
  mem,
  resetSync,
  seedSub,
  setScenario,
} from "@/test/gbp-sync-harness";
import { syncListing } from "@/lib/gbp/sync/run";
import { sentimentBasis } from "@/lib/reputation/sentiment-basis";
import { GET } from "./route";

const ORIGINAL = { ...process.env };

interface Body {
  summary: Record<string, unknown> | null;
  reviews: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
  code?: string;
}

async function read(uid: string, sa = SA) {
  const res = await GET(asUser(`http://127.0.0.1:3100/api/sub-accounts/${sa}/gbp/reviews`, uid), {
    params: Promise.resolve({ id: sa }),
  });
  const text = await res.text();
  expect(text).not.toMatch(LEAK_MARKERS);
  // reviewName carries the GBP account id; the browser has no use for it.
  expect(text).not.toMatch(/reviewName|accounts\/|private\//);
  return { status: res.status, body: JSON.parse(text) as Body };
}

beforeEach(async () => {
  resetSync();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await syncListing(SA, { trigger: "scheduled" });
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("authorization", () => {
  it("lets a collaborator read", async () => {
    const { status, body } = await read("uid_collab");
    expect(status).toBe(200);
    expect(body.reviews).toHaveLength(7);
  });

  it.each([
    ["a signed-in non-member", "uid_stranger"],
    ["an admin of ANOTHER sub-account", "uid_other_admin"],
  ])("refuses %s", async (_l, uid) => {
    expect((await read(uid)).status).toBe(403);
  });

  it("refuses with gate_off when the agency gate is off", async () => {
    seedSub(SA, { gateOn: false });
    const res = await read("uid_admin");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("gate_off");
  });
});

describe("payload", () => {
  it("returns active reviews newest first, byte-exact, with owner replies", async () => {
    const { body } = await read("uid_admin");
    expect(body.reviews.map((r) => r.reviewId)).toEqual([
      "fake-r7", "fake-r6", "fake-r5", "fake-r4", "fake-r3", "fake-r2", "fake-r1",
    ]);
    expect(body.reviews[0]).toEqual({
      reviewId: "fake-r7",
      // The cache doc id — what the reply route is addressed by (already public in the feed).
      docId: expect.stringMatching(/^[0-9a-f]{40}$/),
      reviewer: { displayName: "Fixture Reviewer fake-r7", profilePhotoUrl: null, isAnonymous: false },
      starRating: 5,
      comment: "Fixture review: installed on the day promised.",
      createTime: "2026-08-27T09:00:00.000Z",
      updateTime: "2026-08-27T09:00:00.000Z",
      reply: { comment: "Thank you from the fixture team.", updateTime: "2026-08-27T12:00:00Z" },
      sentiment: null,
    });
    expect(body.reviews[2].comment).toContain("(Translated by Google)");
    expect(body.reviews[6].comment).toBe("  Fixture review with leading and trailing spaces.  ");
  });

  it("returns the summary with health derived now, and the runs' public subset", async () => {
    const { body } = await read("uid_admin");
    expect(body.summary).toMatchObject({
      averageRating: 3.6, totalReviewCount: 7, lastRunStatus: "success", health: "ok",
      lastSuccessfulSyncAt: expect.any(String),
    });
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({ trigger: "scheduled", status: "success", created: 7 });
    expect(Object.keys(body.runs[0])).not.toContain("actorUid");
  });

  it("re-derives stale health from an old summary rather than trusting the stored value", async () => {
    const sub = mem.read(`subAccounts/${SA}`)!;
    const old = new Date(Date.now() - 13 * 3600_000);
    mem.seed(`subAccounts/${SA}`, { ...sub, gbpSummary: { ...(sub.gbpSummary as object), lastSuccessfulSyncAt: old, health: "ok" } });
    expect((await read("uid_admin")).body.summary?.health).toBe("stale");
  });

  it("after a reconnect, says sync pending — never still revoked", async () => {
    setScenario(SA, (s) => void (s.revoked = true));
    await syncListing(SA, { trigger: "scheduled" });
    expect((await read("uid_admin")).body.summary?.health).toBe("reconnect_required");
    const sub = mem.read(`subAccounts/${SA}`)!;
    mem.seed(`subAccounts/${SA}`, {
      ...sub,
      googleConnectionMeta: { ...(sub.googleConnectionMeta as object), reconnectRequired: false, reconnectReason: null },
    });
    expect((await read("uid_admin")).body.summary?.health).toBe("sync_pending");
  });

  it("leaves out tombstoned reviews and anything not of the current listing", async () => {
    setScenario(SA, (s) => {
      s.reviews[LOC_A].reviews = s.reviews[LOC_A].reviews.filter((r) => r.reviewId !== "fake-r4");
      s.reviews[LOC_A].totalReviewCount = 6;
    });
    await syncListing(SA, { trigger: "scheduled" }); // first miss
    await syncListing(SA, { trigger: "scheduled" }); // second → tombstoned
    mem.seed(`subAccounts/${SA}/gbpReviews/stray`, {
      subAccountId: SA, locationName: "locations/some-other", reviewId: "stray", state: "active",
      createTime: new Date(), comment: "not this listing",
    });
    const ids = (await read("uid_admin")).body.reviews.map((r) => r.reviewId);
    expect(ids).not.toContain("fake-r4");
    expect(ids).not.toContain("stray");
    expect(ids).toHaveLength(6);
  });

  it("caps runs at the last 10, newest first", async () => {
    for (let i = 0; i < 11; i++) await syncListing(SA, { trigger: "manual", now: new Date(Date.now() + (i + 1) * 1000) });
    const { body } = await read("uid_admin");
    expect(body.runs).toHaveLength(10);
    expect(body.runs[0].trigger).toBe("manual");
  });

  it("with no listing selected, returns nothing cached", async () => {
    seedSub(SA, { listing: null });
    const { body } = await read("uid_admin");
    expect(body).toMatchObject({ summary: null, reviews: [] });
  });
});

describe("sentiment (SP5 b)", () => {
  function label(reviewId: string, basisOverride?: string) {
    const doc = mem.list(`subAccounts/${SA}/gbpReviews`).find((d) => d.reviewId === reviewId)!;
    const basisHash = basisOverride ?? sentimentBasis(doc.starRating as number, (doc.comment as string | null) ?? null);
    mem.seed(`subAccounts/${SA}/gbpReviews/${doc.id}`, {
      ...mem.read(`subAccounts/${SA}/gbpReviews/${doc.id}`)!,
      sentiment: { label: "negative", method: "ai", basisHash, model: "some/model", at: new Date() },
    });
    return doc.id;
  }

  it("each review carries only its label and method — never the basis, model or time", async () => {
    const id = label("fake-r6");
    const { body } = await read("uid_collab");
    expect(body.reviews.find((r) => r.docId === id)!.sentiment).toEqual({ label: "negative", method: "ai" });
    expect(JSON.stringify(body)).not.toMatch(/basisHash|some\/model/);
    expect(body.reviews.filter((r) => r.sentiment === null)).toHaveLength(6);
  });

  it("a label from older content is stale and reads as absent (a sync edit keeps it on the doc)", async () => {
    const id = label("fake-r6");
    setScenario(SA, (s) => {
      const r = s.reviews[LOC_A].reviews.find((x) => x.reviewId === "fake-r6")!;
      r.comment = "Fixture review: edited at Google.";
      r.updateTime = "2026-09-01T09:00:00Z";
    });
    await syncListing(SA, { trigger: "scheduled" }); // Reviews AI gate off: nothing re-classifies it
    expect(mem.read(`subAccounts/${SA}/gbpReviews/${id}`)?.sentiment).toBeTruthy(); // still on the doc…
    const { body } = await read("uid_collab");
    expect(body.reviews.find((r) => r.docId === id)!.sentiment).toBeNull(); // …but never served
  });
});
