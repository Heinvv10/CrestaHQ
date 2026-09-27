import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST …/gbp/reviews/[reviewDocId]/auto-reply/dismiss — the Reviews tab's
 * Discard. Guarded exactly like the reply route (its route.test.ts): who may
 * dismiss, which review, the agency gate. Every refusal writes nothing and
 * nothing ever reaches Google. Real route, real tenancy, real gate, real
 * dismissAutoReply; only Firestore is in memory.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { createHash } from "node:crypto";
import { ACCOUNT, AGENCY, LEAK_MARKERS, LOC_NORTH, OTHER_SA, SA, mem, removeExtraListings, resetSync, seedExtraListing } from "@/test/gbp-sync-harness";
import { calls, docIdOf, reviewPath } from "@/test/gbp-reply-harness";
import {
  A1, dismissedPath, draftsMade, patchSettings, pendingOf, posts, putFixtureReview, resetAutoReply, sync, syncAndRun,
} from "@/test/auto-reply-harness";
import { autoReplyAfterSync } from "@/lib/reputation/auto-reply/run";
import { autoReplyLeasePath } from "@/lib/reputation/auto-reply/store";
import { syncListing } from "@/lib/gbp/sync/run";
import { syncSubAccount } from "@/lib/gbp/sync/sub-account";
import { reviewsCollection } from "@/lib/gbp/sync/types";
import { reviewBasis } from "@/lib/reputation/sentiment-basis";
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

/** A held auto-reply draft on `reviewId` (the rows Discard is offered on). */
function hold(reviewId: string, sa = SA) {
  const d = mem.read(reviewPath(reviewId, sa))!;
  mem.seed(reviewPath(reviewId, sa), {
    ...d, pendingReply: { text: "Held draft.", textHash: "h", basisHash: reviewBasis(d as never), reason: "approval", at: new Date(), model: "fake" },
  });
}

/** Nothing dismissed for SA or OTHER_SA, and nothing reached Google. */
function expectUntouched() {
  expect(mem.read(reviewPath("fake-r6"))?.pendingReply).toMatchObject({ reason: "approval", text: "Held draft." });
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
  hold("fake-r6");
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

describe("what may be dismissed", () => {
  it("a replied review — with or without a draft — is 409 nothing_to_dismiss, nothing written", async () => {
    expect(await dismiss("uid_admin", SA, docIdOf("fake-r7"))).toMatchObject({ status: 409, body: { code: "nothing_to_dismiss" } });
    hold("fake-r7");
    expect(await dismiss("uid_admin", SA, docIdOf("fake-r7"))).toMatchObject({ status: 409, body: { code: "nothing_to_dismiss" } });
    expect(mem.read(reviewPath("fake-r7"))!.pendingReply).toMatchObject({ reason: "approval" });
    expect(mem.read(dismissedPath("fake-r7"))).toBeUndefined();
  });

  it("an unreplied review without an auto-reply draft is 409 nothing_to_dismiss, nothing written", async () => {
    expect(await dismiss("uid_admin", SA, docIdOf("fake-r2"))).toMatchObject({ status: 409, body: { code: "nothing_to_dismiss" } });
    expect(mem.read(reviewPath("fake-r2"))!.pendingReply).toBeUndefined();
    expect(mem.read(dismissedPath("fake-r2"))).toBeUndefined();
  });

  it("a repeat Discard is accepted and keeps the same basis", async () => {
    expect((await dismiss("uid_admin", SA, R6)).status).toBe(200);
    const first = mem.read(dismissedPath("fake-r6"))!.basisHash;
    expect((await dismiss("uid_admin", SA, R6)).status).toBe(200);
    expect(mem.read(dismissedPath("fake-r6"))!.basisHash).toBe(first);
  });
});

describe("a stale draft (the review was edited since)", () => {
  it("a held row without text (no_budget / draft_failed / cap) can be Discarded", async () => {
    resetAutoReply();
    await sync();
    for (const reason of ["no_budget", "draft_failed", "cap"]) {
      const d = mem.read(reviewPath("fake-a1"))!;
      mem.seed(reviewPath("fake-a1"), {
        ...d, pendingReply: { text: null, textHash: null, basisHash: reviewBasis(d as never), reason, at: new Date(), model: null },
      });
      expect((await dismiss("uid_admin", SA, A1)).status).toBe(200);
    }
  });

  it("Discard on a page loaded before a 5★ became a 1★ complaint is refused: the complaint is not silenced", async () => {
    resetAutoReply();
    patchSettings({ modes: { 1: "approval", 2: "approval", 3: "approval", 4: "auto", 5: "approval" } });
    await syncAndRun();
    expect(pendingOf("fake-a1")).toMatchObject({ reason: "approval" }); // the row the admin saw
    putFixtureReview("fake-a1", 1, "Fixture: edited — now a real complaint.", 28);
    await sync(); // the edit lands; the engine has not run since
    const d = mem.read(reviewPath("fake-a1"))!;
    expect((d.pendingReply as { basisHash: string }).basisHash).not.toBe(reviewBasis(d as never));
    expect(await dismiss("uid_admin", SA, A1)).toMatchObject({ status: 409, body: { code: "nothing_to_dismiss" } });
    expect(mem.read(dismissedPath("fake-a1"))).toBeUndefined();
    expect(pendingOf("fake-a1")).toMatchObject({ reason: "approval" });
  });
});

describe("the engine honours it", () => {
  it("a held draft Discarded through the route is never re-drafted or auto-posted", async () => {
    resetAutoReply();
    patchSettings({ modes: { 1: "approval", 2: "approval", 3: "approval", 4: "auto", 5: "approval" } });
    const first = await sync();
    await autoReplyAfterSync(SA, first.startedAt, Date.now() + 240_000);
    expect(pendingOf("fake-a1")).toMatchObject({ reason: "approval" });
    expect((await dismiss("uid_admin", SA, A1)).status).toBe(200);
    patchSettings({ modes: { 1: "approval", 2: "approval", 3: "approval", 4: "auto", 5: "auto" } });
    // The control: a new rating-only 5★ the second run MUST draft and post, and
    // the lease it must take and release — so "nothing for a1" cannot pass vacuously.
    putFixtureReview("fake-a3", 5, null, 29);
    await mem.db.doc(autoReplyLeasePath(SA)).delete();
    const drafts = draftsMade();
    const second = await sync();
    const run = await autoReplyAfterSync(SA, second.startedAt, Date.now() + 240_000);
    expect(run).toMatchObject({ stop: null, posted: 1 });
    expect(mem.read(autoReplyLeasePath(SA))).toMatchObject({ runId: null });
    expect(posts().filter((c) => c.reviewName.endsWith("/reviews/fake-a3"))).toHaveLength(1);
    expect(posts().filter((c) => c.reviewName.endsWith("/reviews/fake-a1"))).toEqual([]);
    expect(pendingOf("fake-a1")).toMatchObject({ reason: "dismissed" });
    expect(draftsMade()).toBe(drafts + 1); // a3 only
  });
});

describe("a review on an extra listing (MULTI_LISTING_V1_PLAN.md H4)", () => {
  const n1 = createHash("sha256").update(`${ACCOUNT}/${LOC_NORTH}/reviews/north-1`).digest("hex").slice(0, 40);
  const n1Path = () => `${reviewsCollection(SA)}/${n1}`;
  beforeEach(async () => {
    seedExtraListing(SA);
    await syncSubAccount(SA, { trigger: "scheduled" });
    const d = mem.read(n1Path())!;
    mem.seed(n1Path(), { ...d, pendingReply: { text: "Held.", textHash: "h", basisHash: reviewBasis(d as never), reason: "approval", at: new Date(), model: "fake" } });
  });

  it("can be dismissed, and the Discard is recorded for it", async () => {
    expect(await dismiss("uid_admin", SA, n1)).toEqual({ status: 200, body: { ok: true } });
    expect(mem.read(n1Path())!.pendingReply).toMatchObject({ reason: "dismissed" });
    expect(mem.list(`subAccounts/${SA}/autoReplyDismissed`).map((d) => d.reviewDocId)).toEqual([n1]);
    expect(calls(SA)).toEqual([]);
  });

  it("404s once that listing is removed", async () => {
    removeExtraListings(SA);
    expect((await dismiss("uid_admin", SA, n1)).status).toBe(404);
    expect(mem.read(n1Path())!.pendingReply).toMatchObject({ reason: "approval" });
  });
});
