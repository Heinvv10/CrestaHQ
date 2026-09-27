import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PUT /api/sub-accounts/[id]/google/extra-listings under concurrency: a stale
 * or concurrent save is refused (`expected`), a removed extra's post-commit
 * clear never deletes a listing that is connected again, and a failed clear
 * after a committed save still answers 200. Through the real routes.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/google-oauth-harness")).adminMock());
vi.mock("firebase-admin/firestore", async () => (await import("@/test/google-oauth-harness")).firestoreMock());

import { SUB, SUB_PATH, resetHarness, state, type Write } from "@/test/google-oauth-harness";
import { LOC_A, LOC_NORTH, enableFakeMode, seedConnection } from "@/test/gbp-route-harness";
import { LOC_C, listingCacheLeft, pair, putExtras, seedListingCache, seedMainAndScenario, subDoc } from "@/test/extra-listings-harness";
import { locId } from "@/lib/gbp/listings";
import { PUT as PUT_MAIN } from "../listing/route";

const ORIGINAL = { ...process.env };
const NORTH_STATE = `${SUB_PATH}/private/gbpSyncState_${locId(LOC_NORTH)}`;
const extrasNow = () => ((subDoc().googleExtraListings ?? []) as Array<{ locationName: string }>).map((l) => l.locationName);

async function putMain(locationName: string) {
  const req = new Request(`http://127.0.0.1:3100/api/sub-accounts/${SUB}/google/listing`, {
    method: "PUT",
    headers: { "x-user-uid": "uid_admin", "content-type": "application/json" },
    body: JSON.stringify(pair(locationName)),
  });
  const res = await PUT_MAIN(req, { params: Promise.resolve({ id: SUB }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Hold the first write matching `when` until `release()`; `reached` resolves once it is held. */
function pauseAt(when: (w: Write) => boolean) {
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const hit = new Promise<void>((r) => (reached = r));
  let armed = true;
  state.afterWrite = async (w) => {
    if (!armed || !when(w)) return;
    armed = false;
    reached();
    await gate;
  };
  return { reached: hit, release };
}

/** NORTH, as the new MAIN listing's synced reviews. */
function seedNorthAsMainCache() {
  for (const n of [1, 2]) {
    state.docs.set(`${SUB_PATH}/gbpReviews/main-north-${n}`, { subAccountId: SUB, locationName: LOC_NORTH, reviewId: `main-north-${n}` });
  }
}

beforeEach(() => {
  resetHarness();
  enableFakeMode();
  seedConnection();
  seedMainAndScenario();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("expected: a stale or concurrent save is refused", () => {
  it("admin A saves [NORTH]; admin B, still seeing none, saves [C] → 409, NORTH kept", async () => {
    expect((await putExtras({ listings: [pair(LOC_NORTH)], expected: [] })).status).toBe(200);
    state.writes = [];
    const res = await putExtras({ listings: [pair(LOC_C)], expected: [] });
    expect([res.status, res.body.code]).toEqual([409, "listings_changed"]);
    expect(state.writes).toEqual([]);
    expect(extrasNow()).toEqual([LOC_NORTH]);
  });

  it("a stale picker cannot re-add an extra removed meanwhile", async () => {
    expect((await putExtras({ listings: [pair(LOC_NORTH)] })).status).toBe(200);
    expect((await putExtras({ listings: [] })).status).toBe(200);
    state.writes = [];
    const res = await putExtras({ listings: [pair(LOC_NORTH), pair(LOC_C)], expected: [pair(LOC_NORTH)] });
    expect([res.status, res.body.code]).toEqual([409, "listings_changed"]);
    expect(state.writes).toEqual([]);
    expect(subDoc().googleLocationNames).toEqual([LOC_A]);
  });

  it("the same extra under another Google account is a different set", async () => {
    expect((await putExtras({ listings: [pair(LOC_NORTH)] })).status).toBe(200);
    const res = await putExtras({ listings: [], expected: [pair(LOC_NORTH, "accounts/someone-else")] });
    expect([res.status, res.body.code]).toEqual([409, "listings_changed"]);
    expect(extrasNow()).toEqual([LOC_NORTH]);
  });

  it("happy path: expected matches the stored set (any order) → saved", async () => {
    expect((await putExtras({ listings: [pair(LOC_NORTH), pair(LOC_C)], expected: [] })).status).toBe(200);
    const res = await putExtras({ listings: [pair(LOC_C)], expected: [pair(LOC_C), pair(LOC_NORTH)] });
    expect(res).toEqual({ status: 200, body: { ok: true, added: [], removed: [LOC_NORTH] } });
    expect(extrasNow()).toEqual([LOC_C]);
  });
});

describe("a removed extra's clear never deletes a listing connected again (breaker REPRO 2)", () => {
  beforeEach(async () => {
    expect((await putExtras({ listings: [pair(LOC_NORTH)] })).status).toBe(200);
    seedListingCache(LOC_NORTH);
  });

  it("NORTH made the main before its clear starts: the clear is skipped, NORTH's reviews survive", async () => {
    const paused = pauseAt((w) => w.path === SUB_PATH && "googleExtraListings" in (w.data ?? {}));
    const removal = putExtras({ listings: [] });
    await paused.reached;
    expect(await putMain(LOC_NORTH)).toEqual({ status: 200, body: { ok: true } });
    seedNorthAsMainCache();
    paused.release();
    expect((await removal).status).toBe(200);
    expect(subDoc().googleListing).toMatchObject({ locationName: LOC_NORTH });
    expect(listingCacheLeft(LOC_NORTH).reviews).toBe(2);
  });

  it("while NORTH's clear holds its lease, making NORTH the main is refused 409 listing_clearing", async () => {
    const paused = pauseAt((w) => w.path === NORTH_STATE && (w.data?.lease as { runId?: string } | undefined)?.runId === "clearing");
    const removal = putExtras({ listings: [] });
    await paused.reached;
    state.writes = [];
    const res = await putMain(LOC_NORTH);
    expect([res.status, res.body.code]).toEqual([409, "listing_clearing"]);
    expect(state.writes).toEqual([]);
    paused.release();
    expect((await removal).status).toBe(200);
    expect(subDoc().googleListing).toMatchObject({ locationName: LOC_A });
    expect(listingCacheLeft(LOC_NORTH)).toEqual({ reviews: 0, summary: null, syncState: false });
  });

  it("an expired clearing lease (a clear that died) does not block the main PUT", async () => {
    expect((await putExtras({ listings: [] })).status).toBe(200);
    state.docs.set(NORTH_STATE, { lease: { runId: "clearing", until: Date.now() - 1 } });
    expect(await putMain(LOC_NORTH)).toEqual({ status: 200, body: { ok: true } });
  });
});

describe("a clear that fails after the save committed", () => {
  it("answers 200 cachePending, logs it, and the save stands", async () => {
    expect((await putExtras({ listings: [pair(LOC_NORTH), pair(LOC_C)] })).status).toBe(200);
    seedListingCache(LOC_C);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    state.afterWrite = (w) => {
      if (w.path === NORTH_STATE) throw new Error("firestore unavailable");
    };
    const res = await putExtras({ listings: [] });
    expect(res).toEqual({ status: 200, body: { ok: true, added: [], removed: [LOC_NORTH, LOC_C], cachePending: true } });
    expect(subDoc().googleLocationNames).toEqual([LOC_A]);
    expect(errors).toHaveBeenCalledWith(expect.stringMatching(/^\[gbp\/extra-listings\] .*sa=sa_1/));
    // The clear goes on with the next removed listing.
    expect(listingCacheLeft(LOC_C)).toEqual({ reviews: 0, summary: null, syncState: false });
  });
});
