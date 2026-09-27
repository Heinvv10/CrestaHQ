import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Reconnect re-verifies the EXTRA listings too (MULTI_LISTING_V1_PLAN.md
 * PR 3): an extra the new grant provably cannot see is removed on its own —
 * audited, only its synced data dropped — and the main listing is kept. The
 * real callback route, fake provider, Firestore faked underneath.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/google-oauth-harness")).adminMock());
vi.mock("firebase-admin/firestore", async () => (await import("@/test/google-oauth-harness")).firestoreMock());

import { SUB, SUB_PATH, request, resetHarness, state } from "@/test/google-oauth-harness";
import { signGoogleState } from "@/lib/google/oauth";
import { DEFAULT_ACCOUNT, LOC_A, LOC_NORTH, enableFakeMode, setScenario } from "@/test/gbp-route-harness";
import { LOC_C, events, listingCacheLeft, seedListingCache, seedMainAndScenario, subDoc } from "@/test/extra-listings-harness";
import { GET as CALLBACK } from "./route";

const ORIGINAL = { ...process.env };
const GONE = "locations/not-under-this-google-account";

function callback() {
  const url = new URL("http://127.0.0.1:3100/api/google/callback");
  url.searchParams.set("code", `fake-code:${SUB}`);
  url.searchParams.set("state", signGoogleState({ subAccountId: SUB, uid: "uid_admin" }));
  return CALLBACK(request(url.toString(), "uid_admin"));
}

const extra = (locationName: string) => ({ accountName: DEFAULT_ACCOUNT, locationName, title: locationName });

beforeEach(() => {
  resetHarness();
  enableFakeMode();
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  seedMainAndScenario();
  state.docs.set(SUB_PATH, {
    ...subDoc(),
    googleExtraListings: [extra(LOC_NORTH), extra(GONE), extra(LOC_C)],
    googleLocationNames: [LOC_A, LOC_NORTH, GONE, LOC_C],
  });
  for (const loc of [LOC_A, LOC_NORTH, GONE]) seedListingCache(loc);
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("reconnect with extra listings", () => {
  it("removes only the extra the new grant cannot see, audited, and keeps the main", async () => {
    const res = await callback();
    expect(res.headers.get("location")).toContain("google=connected");
    expect(subDoc().googleListing).toMatchObject({ locationName: LOC_A });
    expect((subDoc().googleExtraListings as Array<{ locationName: string }>).map((l) => l.locationName)).toEqual([LOC_NORTH, LOC_C]);
    expect(subDoc().googleLocationNames).toEqual([LOC_A, LOC_NORTH, LOC_C]);
    expect(events()).toEqual([
      {
        type: "extra_listing_removed",
        reason: "not_accessible_after_reconnect",
        agencyId: "ag_1",
        subAccountId: SUB,
        createdByUid: "uid_admin",
        at: "SERVER_TS",
        locationName: GONE,
      },
    ]);
    expect(listingCacheLeft(GONE)).toEqual({ reviews: 0, summary: null, syncState: false });
    expect(listingCacheLeft(LOC_A)).toMatchObject({ reviews: 2, syncState: true });
    expect(listingCacheLeft(LOC_NORTH)).toMatchObject({ reviews: 2, syncState: true });
  });

  it("keeps every extra when the re-verify walk is truncated", async () => {
    setScenario((s) => {
      const base = s.locations[DEFAULT_ACCOUNT][0];
      // Main first (found on page 1), then enough filler to truncate the walk.
      s.locations[DEFAULT_ACCOUNT] = [base, ...Array.from({ length: 70 }, (_, i) => ({ ...base, name: `locations/filler-${i}` }))];
    });
    await callback();
    expect(subDoc().googleLocationNames).toEqual([LOC_A, LOC_NORTH, GONE, LOC_C]);
    expect(events()).toEqual([]);
  });

  it("a main the new grant cannot see still clears everything", async () => {
    state.docs.set(SUB_PATH, { ...subDoc(), googleListing: { accountName: DEFAULT_ACCOUNT, locationName: GONE.replace("not", "also-not") } });
    await callback();
    expect(subDoc()).toMatchObject({ googleListing: null, googleExtraListings: [], googleLocationNames: [] });
    expect(listingCacheLeft(LOC_NORTH)).toEqual({ reviews: 0, summary: null, syncState: false });
    expect(events().filter((e) => e.type === "extra_listing_removed").map((e) => [e.reason, e.locationName, e.agencyId, e.createdByUid])).toEqual(
      [LOC_NORTH, GONE, LOC_C].map((loc) => ["not_accessible_after_reconnect", loc, "ag_1", "uid_admin"]),
    );
  });

  it("single listing: no extras, no extra walk, nothing removed", async () => {
    state.docs.set(SUB_PATH, { ...subDoc(), googleExtraListings: undefined, googleLocationNames: [LOC_A] });
    await callback();
    expect(subDoc().googleListing).toMatchObject({ locationName: LOC_A });
    expect(events()).toEqual([]);
  });
});
