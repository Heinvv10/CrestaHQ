import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST …/gbp/reviews/[reviewDocId]/auto-reply/dismiss — the Reviews tab's
 * Discard. Guarded exactly like the reply route (its route.test.ts): who may
 * dismiss, which review, the agency gate. Every refusal writes nothing and
 * nothing ever reaches Google. Real route, real tenancy, real gate, real
 * dismissAutoReply; only Firestore is in memory.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { AGENCY, LEAK_MARKERS, OTHER_SA, SA, mem, resetSync } from "@/test/gbp-sync-harness";
import { calls, docIdOf, reviewPath } from "@/test/gbp-reply-harness";
import { A1, dismissedPath, posts, resetAutoReply, sync, draftsMade } from "@/test/auto-reply-harness";
import { autoReplyAfterSync } from "@/lib/reputation/auto-reply/run";
import { syncListing } from "@/lib/gbp/sync/run";
import { POST } from "./route";

const R6 = docIdOf("fake-r6");

async function dismiss(uid: string, sa: string, docId: string) {
  const url = `http://127.0.0.1:3100/api/sub-accounts/${sa}/gbp/reviews/${docId}/auto-reply/dismiss`;
  const res = await POST(new Request(url, { method: "POST", headers: { "x-user-uid": uid } }), {
    params: Promise.resolve({ id: sa, reviewDocId: docId }),
  });
  const text = await res.text();
  expect(text).not.toMatch(LEAK_MARKERS);
  return { status: res.status, body: JSON.parse(text) as { code?: string; ok?: boolean } };
}

/** Nothing dismissed for SA or OTHER_SA, and nothing reached Google. */
function expectUntouched() {
  expect(mem.read(reviewPath("fake-r6"))?.pendingReply).toBeUndefined();
  expect(mem.list(`subAccounts/${SA}/autoReplyDismissed`)).toEqual([]);
  expect(mem.list(`subAccounts/${OTHER_SA}/autoReplyDismissed`)).toEqual([]);
  expect(calls(SA)).toEqual([]);
  expect(calls(OTHER_SA)).toEqual([]);
}

beforeEach(async () => {
  resetSync();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await syncListing(SA, { trigger: "scheduled" });
  await syncListing(OTHER_SA, { trigger: "scheduled" });
});
const ORIGINAL = { ...process.env };
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("who may dismiss", () => {
  it("a sub-account admin: the draft is dismissed for this content, recorded outside the cache, nothing sent", async () => {
    expect(await dismiss("uid_admin", SA, R6)).toEqual({ status: 200, body: { ok: true } });
    const pending = mem.read(reviewPath("fake-r6"))!.pendingReply as Record<string, unknown>;
    expect(pending).toMatchObject({ reason: "dismissed", text: null, textHash: null });
    expect(typeof pending.basisHash).toBe("string");
    expect(mem.read(dismissedPath("fake-r6"))).toMatchObject({
      agencyId: AGENCY, subAccountId: SA, createdByUid: "uid_admin", byUid: "uid_admin", basisHash: pending.basisHash, reviewDocId: R6,
    });
    expect(calls(SA)).toEqual([]);
  });

  it.each([
    ["a collaborator (read-only role)", "uid_collab"],
    ["a signed-in non-member", "uid_stranger"],
    ["an admin of ANOTHER sub-account", "uid_other_admin"],
  ])("refuses %s — nothing written", async (_l, uid) => {
    expect((await dismiss(uid, SA, R6)).status).toBe(403);
    expectUntouched();
  });

  it("another tenant's admin guessing this review's id on their own sub-account gets 404", async () => {
    await mem.db.doc(reviewPath("fake-r6", OTHER_SA)).delete();
    expect((await dismiss("uid_other_admin", OTHER_SA, R6)).status).toBe(404);
    expectUntouched();
  });

  it("refuses with gate_off when the agency gate is off", async () => {
    mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, googleEnabledByAgency: false });
    expect(await dismiss("uid_admin", SA, R6)).toMatchObject({ status: 403, body: { code: "gate_off" } });
    expectUntouched();
  });

  it("answers gate_off before looking at the review — even for an id that does not exist", async () => {
    mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, googleEnabledByAgency: false });
    expect(await dismiss("uid_admin", SA, "0".repeat(40))).toMatchObject({ status: 403, body: { code: "gate_off" } });
  });
});

describe("which review", () => {
  it("404s a review Google removed (a tombstone)", async () => {
    mem.seed(reviewPath("fake-r6"), { ...mem.read(reviewPath("fake-r6"))!, state: "removed" });
    expect((await dismiss("uid_admin", SA, R6)).status).toBe(404);
    expect(mem.list(`subAccounts/${SA}/autoReplyDismissed`)).toEqual([]);
  });

  it("404s a cached review of another listing", async () => {
    mem.seed(reviewPath("fake-r6"), { ...mem.read(reviewPath("fake-r6"))!, locationName: "locations/some-other" });
    expect((await dismiss("uid_admin", SA, R6)).status).toBe(404);
    expectUntouched();
  });

  it("404s an id that smuggles a path — even onto an active-looking nested doc", async () => {
    const smuggled = `${R6}/nested/doc`;
    mem.seed(`subAccounts/${SA}/gbpReviews/${smuggled}`, { ...mem.read(reviewPath("fake-r6"))! });
    expect((await dismiss("uid_admin", SA, smuggled)).status).toBe(404);
    expectUntouched();
  });

  it.each(["nope", R6.toUpperCase(), `${R6}0`, "..%2Fprivate%2FgoogleConnection"])("404s a malformed id %s", async (id) => {
    expect((await dismiss("uid_admin", SA, id)).status).toBe(404);
    expectUntouched();
  });
});

describe("the engine honours it", () => {
  it("a review Discarded through the route is never drafted or auto-posted, on this run or the next", async () => {
    resetAutoReply();
    const first = await sync();
    expect((await dismiss("uid_admin", SA, A1)).status).toBe(200);
    await autoReplyAfterSync(SA, first.startedAt, Date.now() + 240_000);
    const second = await sync();
    await autoReplyAfterSync(SA, second.startedAt, Date.now() + 240_000);
    expect(posts().filter((c) => c.reviewName.endsWith("/reviews/fake-a1"))).toEqual([]);
    expect(posts()).toHaveLength(1); // fake-a2 (4★ rating-only) still auto-posts
    expect(draftsMade()).toBe(1);
  });
});
