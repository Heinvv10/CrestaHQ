import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * DELETE /api/sub-accounts/[id]/google/listing while extra listings are
 * connected: refused 409 has_extra_listings (extras always sit beside a main
 * listing). Disconnect still clears everything — see google/route.test.ts.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/google-oauth-harness")).adminMock());
vi.mock("firebase-admin/firestore", async () => (await import("@/test/google-oauth-harness")).firestoreMock());

import { SUB, SUB_PATH, request, resetHarness, state } from "@/test/google-oauth-harness";
import { LOC_A, LOC_NORTH, enableFakeMode, seedConnection } from "@/test/gbp-route-harness";
import { listingCacheLeft, pair, putExtras, seedListingCache, seedMainAndScenario, subDoc } from "@/test/extra-listings-harness";
import { DELETE as DISCONNECT } from "../route";
import { DELETE } from "./route";

const ORIGINAL = { ...process.env };
const URL_ = `http://127.0.0.1:3100/api/sub-accounts/${SUB}/google/listing`;
const del = async () => {
  const res = await DELETE(request(URL_, "uid_admin", "DELETE"), { params: Promise.resolve({ id: SUB }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

beforeEach(async () => {
  resetHarness();
  enableFakeMode();
  seedConnection();
  seedMainAndScenario();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  expect((await putExtras({ listings: [pair(LOC_NORTH)] })).status).toBe(200);
  for (const loc of [LOC_A, LOC_NORTH]) seedListingCache(loc);
  state.writes = [];
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

it("refuses to clear the main listing while an extra is connected, and writes nothing", async () => {
  const before = structuredClone(subDoc());
  const res = await del();
  expect([res.status, res.body.code]).toEqual([409, "has_extra_listings"]);
  expect(state.writes).toEqual([]);
  expect(subDoc()).toEqual(before);
});

it("clears once the extras are removed", async () => {
  expect((await putExtras({ listings: [] })).status).toBe(200);
  expect(await del()).toEqual({ status: 200, body: { ok: true } });
  expect(subDoc().googleListing).toBeNull();
  expect(subDoc().googleLocationNames).toEqual([]);
});

it("disconnect still clears the main, every extra and all their synced data", async () => {
  const res = await DISCONNECT(request(`http://127.0.0.1:3100/api/sub-accounts/${SUB}/google`, "uid_admin", "DELETE"), {
    params: Promise.resolve({ id: SUB }),
  });
  expect(res.status).toBe(200);
  expect(subDoc()).toMatchObject({ googleListing: null, googleExtraListings: [], googleLocationNames: [] });
  expect(subDoc().gbpSummaries).toBeUndefined();
  for (const loc of [LOC_A, LOC_NORTH]) expect(listingCacheLeft(loc)).toEqual({ reviews: 0, summary: null, syncState: false });
  expect(state.docs.has(`${SUB_PATH}/private/gbpSyncState`)).toBe(false);
});
