import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/firebase/admin", async () => (await import("@/test/google-oauth-harness")).adminMock());
vi.mock("firebase-admin/firestore", async () => (await import("@/test/google-oauth-harness")).firestoreMock());
import { SUB_PATH, resetHarness, state } from "@/test/google-oauth-harness";
import { DEFAULT_ACCOUNT, LOC_A, LOC_NORTH, enableFakeMode, seedConnection, setScenario } from "@/test/gbp-route-harness";
import { LOC_C, listingCacheLeft, pair, putExtras, seedListingCache } from "@/test/extra-listings-harness";

const ACCT2 = "accounts/second-group";
beforeEach(() => {
  resetHarness(); enableFakeMode(); seedConnection();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  setScenario((s) => {
    const base = s.locations[DEFAULT_ACCOUNT];
    base.push({ ...base[0], name: LOC_C, title: "Third" });
    s.accounts.push({ name: ACCT2, accountName: "Second Group", type: "LOCATION_GROUP" } as never);
    s.locations[ACCT2] = [{ ...base.find((l) => l.name === LOC_NORTH)! }];
  });
  state.docs.set(SUB_PATH, { ...state.docs.get(SUB_PATH), googleListing: { accountName: DEFAULT_ACCOUNT, locationName: LOC_A, title: "Main" }, googleLocationNames: [LOC_A] });
});
afterEach(() => vi.restoreAllMocks());

it("switching a listing's Google account in one save is refused; remove then re-add starts empty", async () => {
  expect((await putExtras({ listings: [pair(LOC_NORTH)] })).status).toBe(200);
  seedListingCache(LOC_NORTH);
  expect((await putExtras({ listings: [pair(LOC_NORTH, ACCT2)] })).body.code).toBe("account_changed");
  expect((await putExtras({ listings: [] })).status).toBe(200);
  expect((await putExtras({ listings: [pair(LOC_NORTH, ACCT2)] })).status).toBe(200);
  expect(listingCacheLeft(LOC_NORTH)).toEqual({ reviews: 0, summary: null, syncState: false });
});
