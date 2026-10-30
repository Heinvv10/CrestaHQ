import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MULTI_LISTING_V1_PLAN.md H4 — a reply to a review on an EXTRA listing goes
 * through the real reply route to THAT review (its own `reviewName`, so its
 * own listing at Google), and lands on its own cached doc. The review must be
 * on a listing CURRENTLY connected to this sub-account — main or extra — and
 * nothing weaker: an unknown, removed or foreign location is still a 404 with
 * zero calls to Google. Real route, tenancy, gate and fake provider behind
 * the real fence; Firestore in memory.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { createHash } from "node:crypto";
import {
  ACCOUNT, LEAK_MARKERS, LOC_A, LOC_NORTH, SA, mem, removeExtraListings, resetSync, seedExtraListing,
} from "@/test/gbp-sync-harness";
import { KEY, callReply, calls, docIdOf, reviewPath } from "@/test/gbp-reply-harness";
import { syncSubAccount } from "@/lib/gbp/sync/sub-account";
import { reviewsCollection } from "@/lib/gbp/sync/types";
import { DELETE, POST } from "./route";

const ORIGINAL = { ...process.env };
const northName = (id: string) => `${ACCOUNT}/${LOC_NORTH}/reviews/${id}`;
const northDocId = (id: string) => createHash("sha256").update(northName(id)).digest("hex").slice(0, 40);
const northPath = (id: string) => `${reviewsCollection(SA)}/${northDocId(id)}`;
const N1 = northDocId("north-1");
const body = (over: Record<string, unknown> = {}) => ({ comment: "Thanks from the north branch.", idempotencyKey: KEY, ...over });

async function post(docId: string, b: unknown = body()) {
  const r = await callReply(POST, "POST", "uid_admin", SA, docId, b);
  expect(r.text).not.toMatch(LEAK_MARKERS);
  return r;
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

describe("a review on the extra listing", () => {
  it("is replied to at its own name, and its own cached doc gets the reply", async () => {
    expect(mem.read(northPath("north-1"))).toMatchObject({ locationName: LOC_NORTH, state: "active", reply: null });
    const r = await post(N1);
    expect(r.status).toBe(200);
    expect(calls()).toEqual([{ op: "putReply", reviewName: northName("north-1") }]);
    expect(mem.read(northPath("north-1"))?.reply).toMatchObject({ comment: "Thanks from the north branch." });
    // Main's reviews are untouched.
    expect(mem.read(reviewPath("fake-r6"))?.reply).toBeNull();
  });

  it("its reply can be deleted, at its own name", async () => {
    await post(N1);
    const r = await callReply(DELETE, "DELETE", "uid_admin", SA, N1);
    expect(r.status).toBe(200);
    expect(calls().at(-1)).toEqual({ op: "deleteReply", reviewName: northName("north-1") });
    expect(mem.read(northPath("north-1"))?.reply).toBeNull();
  });

  it("main's reviews still reply as before", async () => {
    expect((await post(docIdOf("fake-r6"))).status).toBe(200);
    expect(calls()).toEqual([{ op: "putReply", reviewName: `${ACCOUNT}/${LOC_A}/reviews/fake-r6` }]);
  });
});

describe("membership — nothing weaker", () => {
  it("404s, zero calls, once the extra listing is removed (its doc still active in the cache)", async () => {
    removeExtraListings(SA);
    expect(mem.read(northPath("north-1"))?.state).toBe("active");
    expect((await post(N1)).status).toBe(404);
    expect(calls()).toEqual([]);
  });

  it("404s, zero calls, for an active doc on a location this sub-account never connected", async () => {
    const d = mem.read(northPath("north-1"))!;
    mem.seed(northPath("north-1"), { ...d, locationName: "locations/not-connected" });
    expect((await post(N1)).status).toBe(404);
    expect(calls()).toEqual([]);
  });

  it("404s, zero calls, when the sub-account has no listing at all", async () => {
    const sub = mem.read(`subAccounts/${SA}`)!;
    mem.seed(`subAccounts/${SA}`, { ...sub, googleListing: null, googleExtraListings: [], googleLocationNames: [] });
    expect((await post(N1)).status).toBe(404);
    expect((await post(docIdOf("fake-r6"))).status).toBe(404);
    expect(calls()).toEqual([]);
  });

  it("404s a tombstoned extra-listing review", async () => {
    mem.seed(northPath("north-1"), { ...mem.read(northPath("north-1"))!, state: "removed" });
    expect((await post(N1)).status).toBe(404);
    expect(calls()).toEqual([]);
  });
});
