import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PUT /api/sub-accounts/[id]/google/extra-listings — what a save writes:
 * the server-fetched listings, an exact `googleLocationNames`, one audit
 * event per change, and on removal ONLY that listing's synced data dropped
 * (MULTI_LISTING_V1_PLAN.md H3). Through the real route.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/google-oauth-harness")).adminMock());
vi.mock("firebase-admin/firestore", async () => (await import("@/test/google-oauth-harness")).firestoreMock());

import { SUB, SUB_PATH, resetHarness, state } from "@/test/google-oauth-harness";
import { DEFAULT_ACCOUNT, LOC_A, LOC_NORTH, enableFakeMode, seedConnection, setScenario } from "@/test/gbp-route-harness";
import {
  LOC_C,
  events,
  listingCacheLeft,
  pair,
  putExtras,
  seedListingCache,
  seedMainAndScenario,
  subDoc,
} from "@/test/extra-listings-harness";

const ORIGINAL = { ...process.env };
const extras = () => subDoc().googleExtraListings as Array<Record<string, unknown>>;
const anchors = { agencyId: "ag_1", subAccountId: SUB, createdByUid: "uid_admin", at: "SERVER_TS" };

beforeEach(() => {
  resetHarness();
  enableFakeMode();
  seedConnection();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("adding", () => {
  beforeEach(() => seedMainAndScenario());

  it("answers with the stored extras, in order, as the card shows them — display fields only", async () => {
    const res = await putExtras({ listings: [pair(LOC_C), pair(LOC_NORTH)] });
    expect(res.body.listings).toEqual([
      { accountName: DEFAULT_ACCOUNT, locationName: LOC_C, title: "Velo Test Fibre — Third", address: expect.any(String) },
      { accountName: DEFAULT_ACCOUNT, locationName: LOC_NORTH, title: "Velo Test Fibre — Gqeberha North", address: "9 Fixture Avenue, Gqeberha North, 6100" },
    ]);
    // Removing one answers with what is left.
    const left = await putExtras({ listings: [pair(LOC_NORTH)], expected: [pair(LOC_C), pair(LOC_NORTH)] });
    expect(left.body.listings).toEqual([expect.objectContaining({ locationName: LOC_NORTH })]);
  });

  it("stores exactly the server-fetched listings, in the order given, and audits each", async () => {
    const res = await putExtras({ listings: [{ ...pair(LOC_C), title: "Attacker" }, pair(LOC_NORTH)] });
    expect(res).toEqual({ status: 200, body: { ok: true, added: [LOC_C, LOC_NORTH], removed: [], listings: expect.any(Array) } });
    expect(extras()).toEqual([
      expect.objectContaining({ locationName: LOC_C, title: "Velo Test Fibre — Third", accountDisplayName: "E2E Fixture Group" }),
      {
        accountName: DEFAULT_ACCOUNT,
        accountDisplayName: "E2E Fixture Group",
        locationName: LOC_NORTH,
        title: "Velo Test Fibre — Gqeberha North",
        address: "9 Fixture Avenue, Gqeberha North, 6100",
        websiteUri: "https://north.fixture.example",
        placeId: "fake-place-gqeberha-north",
        mapsUri: "https://maps.fixture.example/?cid=fake-gqeberha-north",
        newReviewUri: "https://review.fixture.example/fake-gqeberha-north",
        selectedAt: expect.any(Date),
        selectedByUid: "uid_admin",
      },
    ]);
    expect(subDoc().googleLocationNames).toEqual([LOC_A, LOC_C, LOC_NORTH]);
    expect(events()).toEqual([
      { type: "extra_listing_added", ...anchors, locationName: LOC_C },
      { type: "extra_listing_added", ...anchors, locationName: LOC_NORTH },
    ]);
    // The main listing is untouched.
    expect(subDoc().googleListing).toEqual({ accountName: DEFAULT_ACCOUNT, locationName: LOC_A, title: "Main" });
  });

  it("writes the listing fields and the flat array in ONE write", async () => {
    await putExtras({ listings: [pair(LOC_NORTH)] });
    const docWrites = state.writes.filter((w) => w.path === SUB_PATH);
    expect(docWrites).toHaveLength(1);
    expect(Object.keys(docWrites[0].data ?? {}).sort()).toEqual(["googleExtraListings", "googleLocationNames", "updatedAt"]);
  });

  it("a kept listing keeps its stored entry — only new pairs come from the re-fetch", async () => {
    await putExtras({ listings: [pair(LOC_NORTH)] });
    const stored = { ...extras()[0], title: "Stored title" };
    state.docs.set(SUB_PATH, { ...subDoc(), googleExtraListings: [stored] });
    await putExtras({ listings: [pair(LOC_NORTH), pair(LOC_C)] });
    expect(extras()[0]).toEqual(stored);
    expect(subDoc().googleLocationNames).toEqual([LOC_A, LOC_NORTH, LOC_C]);
  });

  it("saving the same set again writes nothing", async () => {
    await putExtras({ listings: [pair(LOC_NORTH)] });
    state.writes = [];
    const res = await putExtras({ listings: [pair(LOC_NORTH)] });
    expect(res.body).toEqual({ ok: true, added: [], removed: [], listings: expect.any(Array) });
    expect(state.writes).toEqual([]);
  });
});

describe("a legacy doc (no googleLocationNames, no googleExtraListings)", () => {
  it("gets an exact flat array on its first extra", async () => {
    seedMainAndScenario({ legacy: true });
    expect(subDoc().googleLocationNames).toBeUndefined();
    expect((await putExtras({ listings: [pair(LOC_NORTH)] })).status).toBe(200);
    expect(subDoc().googleLocationNames).toEqual([LOC_A, LOC_NORTH]);
  });
});

describe("add two, then remove one", () => {
  const AUTO_REPLY = { enabled: true, enabledAt: 1, listingLocationName: LOC_A, modes: { five: "post" } };

  beforeEach(async () => {
    seedMainAndScenario();
    expect((await putExtras({ listings: [pair(LOC_NORTH), pair(LOC_C)] })).status).toBe(200);
    for (const loc of [LOC_A, LOC_NORTH, LOC_C]) seedListingCache(loc);
    state.docs.set(SUB_PATH, { ...subDoc(), reviewsAutoReply: structuredClone(AUTO_REPLY) });
    state.docs.set(`${SUB_PATH}/autoReplyNever/k1`, { subAccountId: SUB });
    state.docs.set(`${SUB_PATH}/autoReplyDismissed/k2`, { subAccountId: SUB });
  });

  it("drops only the removed listing's cache, summary and sync state", async () => {
    const mainDocs = [...state.docs.entries()].filter(([, d]) => d.locationName === LOC_A);
    const res = await putExtras({ listings: [pair(LOC_NORTH)] });
    expect(res.body).toEqual({ ok: true, added: [], removed: [LOC_C], listings: expect.any(Array) });
    expect(listingCacheLeft(LOC_C)).toEqual({ reviews: 0, summary: null, syncState: false });
    expect(listingCacheLeft(LOC_NORTH)).toMatchObject({ reviews: 2, syncState: true });
    expect(listingCacheLeft(LOC_A)).toMatchObject({ reviews: 2, syncState: true });
    expect(listingCacheLeft(LOC_A).summary).toMatchObject({ locationName: LOC_A });
    expect(listingCacheLeft(LOC_NORTH).summary).toMatchObject({ locationName: LOC_NORTH });
    // Main's docs — drafts and held-alert basis included — are byte-equal.
    for (const [path, doc] of mainDocs) expect(state.docs.get(path)).toEqual(doc);
    expect(state.docs.has(`${SUB_PATH}/autoReplyNever/k1`)).toBe(true);
    expect(state.docs.has(`${SUB_PATH}/autoReplyDismissed/k2`)).toBe(true);
  });

  it("leaves reviewsAutoReply byte-equal", async () => {
    await putExtras({ listings: [pair(LOC_NORTH)] });
    expect(subDoc().reviewsAutoReply).toEqual(AUTO_REPLY);
  });

  it("rewrites googleLocationNames exactly and audits the removal", async () => {
    await putExtras({ listings: [pair(LOC_NORTH)] });
    expect(subDoc().googleLocationNames).toEqual([LOC_A, LOC_NORTH]);
    expect(extras().map((l) => l.locationName)).toEqual([LOC_NORTH]);
    expect(events().at(-1)).toEqual({ type: "extra_listing_removed", reason: "admin_removed", ...anchors, locationName: LOC_C });
  });

  it("the doc is written BEFORE the removed listing's data is cleared", async () => {
    await putExtras({ listings: [pair(LOC_NORTH)] });
    const docWrite = state.writes.findIndex((w) => w.path === SUB_PATH && "googleExtraListings" in (w.data ?? {}));
    const firstClear = state.writes.findIndex((w) => w.op === "delete" && w.path.includes("/gbpReviews/"));
    expect(docWrite).toBeGreaterThanOrEqual(0);
    expect(firstClear).toBeGreaterThan(docWrite);
  });

  it("removing needs no Google call", async () => {
    setScenario((s) => (s.failNext = { op: "listAccounts", kind: "transient" }));
    expect((await putExtras({ listings: [] })).body).toEqual({ ok: true, added: [], removed: [LOC_NORTH, LOC_C], listings: expect.any(Array) });
    expect(subDoc().googleLocationNames).toEqual([LOC_A]);
    expect(listingCacheLeft(LOC_A)).toMatchObject({ reviews: 2, syncState: true });
  });
});
