import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/google-oauth-harness")).adminMock());
vi.mock("firebase-admin/firestore", async () => (await import("@/test/google-oauth-harness")).firestoreMock());

// Pause clearGbpCache at ENTRY: after clearRemoved's re-read, before the lease write.
const gate = vi.hoisted(() => ({ hold: null as null | { loc: string; wait: Promise<void>; reached: () => void } }));
vi.mock("@/lib/gbp/sync/clear", async (orig) => {
  const real = (await orig()) as typeof import("@/lib/gbp/sync/clear");
  return {
    ...real,
    clearGbpCache: async (sa: string, extra: string | null = null, o?: { unlessHeld?: boolean }) => {
      const h = gate.hold;
      if (h && extra === h.loc) {
        gate.hold = null;
        h.reached();
        await h.wait;
      }
      return real.clearGbpCache(sa, extra, o);
    },
  };
});

import { SUB, resetHarness, state } from "@/test/google-oauth-harness";
import { DEFAULT_ACCOUNT, LOC_NORTH, enableFakeMode, seedConnection } from "@/test/gbp-route-harness";
import { listingCacheLeft, pair, putExtras, seedListingCache, seedMainAndScenario, subDoc } from "@/test/extra-listings-harness";
import { PUT as PUT_MAIN } from "@/app/api/sub-accounts/[id]/google/listing/route";
import { syncStatePath } from "@/lib/gbp/sync/types";

const putMain = async (locationName: string) => {
  const req = new Request(`http://127.0.0.1:3100/api/sub-accounts/${SUB}/google/listing`, {
    method: "PUT",
    headers: { "x-user-uid": "uid_admin", "content-type": "application/json" },
    body: JSON.stringify({ accountName: DEFAULT_ACCOUNT, locationName }),
  });
  const res = await PUT_MAIN(req, { params: Promise.resolve({ id: SUB }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

beforeEach(() => {
  resetHarness();
  enableFakeMode();
  seedConnection();
  seedMainAndScenario();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  gate.hold = null;
});
afterEach(() => vi.restoreAllMocks());

it("a main PUT committing between clearRemoved's re-read and the clear's lease keeps the new main's reviews", async () => {
  expect((await putExtras({ listings: [pair(LOC_NORTH)] })).status).toBe(200);
  let reached!: () => void;
  const hit = new Promise<void>((r) => (reached = r));
  let release!: () => void;
  gate.hold = { loc: LOC_NORTH, wait: new Promise<void>((r) => (release = r)), reached };
  const removal = putExtras({ listings: [] });
  await hit; // re-read done (NORTH not held), lease not yet taken
  const main = await putMain(LOC_NORTH);
  expect(main.status).toBe(200); // neither guard fires
  seedListingCache(LOC_NORTH); // new main's first sync lands
  release();
  expect((await removal).status).toBe(200);
  expect(listingCacheLeft(LOC_NORTH).reviews).toBe(2);
});

it("the re-check runs AFTER the lease: a main committed just before it keeps its reviews, cursor and a free lease", async () => {
  expect((await putExtras({ listings: [pair(LOC_NORTH)] })).status).toBe(200);
  const statePath = syncStatePath(SUB, LOC_NORTH);
  seedListingCache(LOC_NORTH); // the listing's synced cache…
  state.docs.set(statePath, { pass: { cursor: "c1" }, anomalyStreak: 1 }); // …and its sync cursor
  let fired = false;
  state.afterWrite = async (w) => {
    if (fired || w.path !== statePath || (w.data as { lease?: { runId?: string } })?.lease?.runId !== "clearing") return;
    fired = true;
    // Stands in for a main PUT that committed right after the lease write, before the re-read.
    const sub = subDoc();
    state.docs.set(`subAccounts/${SUB}`, { ...sub, googleListing: { ...(sub.googleListing as object), locationName: LOC_NORTH } });
  };
  expect((await putExtras({ listings: [] })).status).toBe(200);
  expect(fired).toBe(true);
  expect(listingCacheLeft(LOC_NORTH).reviews).toBe(2);
  expect(state.docs.get(statePath)).toMatchObject({ lease: null, pass: { cursor: "c1" }, anomalyStreak: 1 });
});

it("after the clear takes its lease, a main PUT on that location is refused listing_clearing", async () => {
  expect((await putExtras({ listings: [pair(LOC_NORTH)] })).status).toBe(200);
  let res: Awaited<ReturnType<typeof putMain>> | undefined;
  state.afterWrite = async (w) => {
    if (w.path.includes("gbpSyncState_") && (w.data as { lease?: { runId?: string } })?.lease?.runId === "clearing" && !res) {
      res = await putMain(LOC_NORTH);
    }
  };
  expect((await putExtras({ listings: [] })).status).toBe(200);
  expect(res?.body.code).toBe("listing_clearing");
});

it("a body without expected is invalid_body", async () => {
  const res = await putExtras(JSON.stringify({ listings: [pair(LOC_NORTH)] }));
  expect(res.status).toBe(400);
});

it("stale expected is refused and writes nothing", async () => {
  expect((await putExtras({ listings: [pair(LOC_NORTH)] })).status).toBe(200);
  const before = JSON.stringify(subDoc().googleExtraListings);
  const res = await putExtras({ listings: [pair(LOC_NORTH)], expected: [] });
  expect(res.body.code).toBe("listings_changed");
  expect(JSON.stringify(subDoc().googleExtraListings)).toBe(before);
});
