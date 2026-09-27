import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET …/gbp/reviews across listings (MULTI_LISTING_V1_PLAN.md PR 4): the
 * default is every connected listing combined, newest first, each review
 * labelled with its listing; `?listing=` narrows to one (validated by shape
 * AND membership, else 400 `invalid_filter` field `listing`); the summary is
 * the selected listing's (main's for "All"); `listings` lists them. Real
 * route and sync on the in-memory store, fake provider behind the real fence.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { LEAK_MARKERS, LOC_A, LOC_NORTH, OTHER_SA, SA, asUser, mem, resetSync, seedExtraListing } from "@/test/gbp-sync-harness";
import { reviewPath } from "@/test/gbp-reply-harness";
import { syncSubAccount } from "@/lib/gbp/sync/sub-account";
import { reviewBasis } from "@/lib/reputation/sentiment-basis";
import { reviewsCollection } from "@/lib/gbp/sync/types";
import { GET } from "./route";

const ORIGINAL = { ...process.env };
const MAIN_TITLE = "Velo Test Fibre — Gqeberha";
const NORTH_TITLE = "Velo Test Fibre — Gqeberha North";

type Row = { reviewId: string; createTime: string; listing: { locationName: string; title: string }; approval: unknown };
interface Body {
  reviews: Row[];
  summary: { totalReviewCount: number | null; averageRating: number | null } | null;
  listings: Array<{ locationName: string; title: string; main: boolean }>;
  available: number;
  needsApproval: number;
  code?: string;
  field?: string;
}

async function read(query = "", uid = "uid_admin") {
  const res = await GET(asUser(`http://127.0.0.1:3100/api/sub-accounts/${SA}/gbp/reviews${query}`, uid), {
    params: Promise.resolve({ id: SA }),
  });
  const text = await res.text();
  expect(text).not.toMatch(LEAK_MARKERS);
  expect(text).not.toMatch(/reviewName|accounts\//);
  return { status: res.status, body: JSON.parse(text) as Body };
}

const northDoc = (reviewId: string) =>
  mem.list(reviewsCollection(SA)).find((d) => d.reviewId === reviewId && d.locationName === LOC_NORTH)!;

function hold(d: Record<string, unknown>) {
  const path = `${reviewsCollection(SA)}/${String(d.id)}`;
  const { id: _id, ...data } = d;
  mem.seed(path, {
    ...data, pendingReply: { text: "Held.", textHash: "h", basisHash: reviewBasis(data as never), reason: "approval", at: new Date(), model: "fake" },
  });
}

beforeEach(async () => {
  resetSync();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  seedExtraListing(SA);
  await syncSubAccount(SA, { trigger: "scheduled" });
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("two listings", () => {
  it("the default is both listings, newest first, each row labelled with its listing", async () => {
    const { status, body } = await read();
    expect(status).toBe(200);
    expect(body.reviews).toHaveLength(10);
    const times = body.reviews.map((r) => r.createTime);
    expect(times).toEqual([...times].sort().reverse());
    expect(new Set(body.reviews.map((r) => r.listing.locationName))).toEqual(new Set([LOC_A, LOC_NORTH]));
    for (const r of body.reviews) {
      expect(r.listing).toEqual(
        r.reviewId.startsWith("north-") ? { locationName: LOC_NORTH, title: NORTH_TITLE } : { locationName: LOC_A, title: MAIN_TITLE },
      );
    }
    expect(body.available).toBe(10);
    expect(body.listings).toEqual([
      { locationName: LOC_A, title: MAIN_TITLE, main: true },
      { locationName: LOC_NORTH, title: NORTH_TITLE, main: false },
    ]);
    // "All" shows the main listing's summary.
    expect(body.summary).toMatchObject({ totalReviewCount: 7, averageRating: 3.6 });
  });

  it("?listing=B serves only B, with B's summary", async () => {
    const { status, body } = await read(`?listing=${LOC_NORTH}`);
    expect(status).toBe(200);
    expect(body.reviews.map((r) => r.reviewId)).toEqual(["north-3", "north-2", "north-1"]);
    expect(body.available).toBe(3);
    expect(body.summary).toMatchObject({ totalReviewCount: 3, averageRating: 3.7 });
    expect(body.listings).toHaveLength(2);
  });

  it("?listing=main serves only main", async () => {
    const { body } = await read(`?listing=${LOC_A}`);
    expect(body.reviews).toHaveLength(7);
    expect(body.reviews.every((r) => r.listing.locationName === LOC_A)).toBe(true);
    expect(body.summary).toMatchObject({ totalReviewCount: 7 });
  });

  it("combines with the other filters", async () => {
    const { body } = await read(`?listing=${LOC_NORTH}&rating=5`);
    expect(body.reviews.map((r) => r.reviewId)).toEqual(["north-3"]);
  });

  it.each([
    ["an unknown location", "locations/not-connected"],
    ["another sub-account's location", "locations/e2e-velo-gqeberha-south"],
    ["a malformed value", "accounts/x/locations/y"],
    ["a path trick", "locations/../x"],
  ])("400 invalid_filter for %s", async (_l, value) => {
    const { status, body } = await read(`?listing=${encodeURIComponent(value)}`);
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: "invalid_filter", field: "listing" });
  });

  it("a location connected only to ANOTHER sub-account is refused", async () => {
    const other = mem.read(`subAccounts/${OTHER_SA}`)!;
    const loc = "locations/held-by-other";
    mem.seed(`subAccounts/${OTHER_SA}`, { ...other, googleExtraListings: [{ ...(other.googleListing as object), locationName: loc }] });
    expect((await read(`?listing=${loc}`)).status).toBe(400);
  });

  it("a member (collaborator) sees exactly what an admin sees", async () => {
    for (const q of ["", `?listing=${LOC_NORTH}`]) {
      expect((await read(q, "uid_collab")).body).toEqual((await read(q, "uid_admin")).body);
    }
  });

  it("needsApproval counts the selected set", async () => {
    hold(northDoc("north-2"));
    hold({ ...mem.read(reviewPath("fake-r6"))!, id: reviewPath("fake-r6").split("/").pop() });
    expect((await read()).body.needsApproval).toBe(2);
    expect((await read(`?listing=${LOC_NORTH}`)).body.needsApproval).toBe(1);
    expect((await read(`?listing=${LOC_A}`)).body.needsApproval).toBe(1);
    expect((await read(`?listing=${LOC_NORTH}&approval=needed`)).body.reviews.map((r) => r.reviewId)).toEqual(["north-2"]);
  });

  it("an extra-listing draft never claims it will auto-post (auto-reply is main-only in v1)", async () => {
    process.env.REVIEWS_AUTO_REPLY_ENABLED = "1";
    // OTHER_SA off LOC_A, so main is not paused by listing_shared.
    const other = mem.read(`subAccounts/${OTHER_SA}`)!;
    mem.seed(`subAccounts/${OTHER_SA}`, { ...other, googleListing: { ...(other.googleListing as object), locationName: "locations/other-sa" } });
    const sub = mem.read(`subAccounts/${SA}`)!;
    mem.seed(`subAccounts/${SA}`, {
      ...sub, reviewsAiEnabledByAgency: true, reviewsAutoReplyEnabledByAgency: true,
      reviewsAutoReply: {
        enabled: true, modes: { 1: "auto", 2: "auto", 3: "auto", 4: "auto", 5: "auto" }, includeBacklog: true,
        enabledAt: new Date(), enabledByUid: "uid_admin", listingLocationName: LOC_A,
      },
    });
    const queue = (d: Record<string, unknown>) => {
      const { id, ...data } = d;
      mem.seed(`${reviewsCollection(SA)}/${String(id)}`, {
        ...data, pendingReply: { text: "Q.", textHash: "h", basisHash: reviewBasis(data as never), reason: "auto_queued", at: new Date(), model: "fake" },
      });
    };
    queue(northDoc("north-3"));
    queue({ ...mem.read(reviewPath("fake-r4"))!, id: reviewPath("fake-r4").split("/").pop() });
    const rows = (await read()).body.reviews;
    expect(rows.find((r) => r.reviewId === "fake-r4")?.approval).toMatchObject({ state: "queued" });
    expect(rows.find((r) => r.reviewId === "north-3")?.approval).toMatchObject({ state: "paused" });
  });
});

describe("main also present in googleExtraListings (the state locationNamesOf/listingFor defend against)", () => {
  it("does not double the main listing's reviews or counts", async () => {
    const clean = await read();
    const sub = mem.read(`subAccounts/${SA}`)!;
    mem.seed(`subAccounts/${SA}`, { ...sub, googleExtraListings: [...(sub.googleExtraListings as unknown[]), sub.googleListing] });
    const dup = await read();
    expect(dup.status).toBe(200);
    expect(dup.body.listings.length).toBe(clean.body.listings.length);
    expect(dup.body.available).toBe(clean.body.available);
    expect(dup.body.reviews.length).toBe(clean.body.reviews.length);
  });
});

describe("single listing: unchanged but for `listings` and each review's `listing`", () => {
  it("listings is [main]; every review is main's; no listing filter needed", async () => {
    resetSync();
    await syncSubAccount(SA, { trigger: "scheduled" });
    const { body } = await read();
    expect(body.listings).toEqual([{ locationName: LOC_A, title: MAIN_TITLE, main: true }]);
    expect(body.reviews).toHaveLength(7);
    expect(body.reviews.every((r) => r.listing.locationName === LOC_A && r.listing.title === MAIN_TITLE)).toBe(true);
    expect(Object.keys(body).sort()).toEqual(
      ["aiDrafts", "available", "listings", "needsApproval", "reviews", "runs", "scheduled", "summary", "truncated"],
    );
    expect((await read(`?listing=${LOC_NORTH}`)).status).toBe(400);
  });

  it("no listing at all: listings is [] and any ?listing= is refused", async () => {
    const sub = mem.read(`subAccounts/${SA}`)!;
    mem.seed(`subAccounts/${SA}`, { ...sub, googleListing: null, googleExtraListings: [], googleLocationNames: [] });
    const { body } = await read();
    expect(body.listings).toEqual([]);
    expect(body.reviews).toEqual([]);
    expect((await read(`?listing=${LOC_A}`)).status).toBe(400);
  });
});
