import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The explicit human reply: exactly one provider call per attempt, an
 * idempotency key that makes a retry free, a failure that leaves the cache
 * honest, and no path but this route that ever posts or deletes a reply.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { AGENCY, SA, mem, resetSync, setScenario } from "@/test/gbp-sync-harness";
import {
  KEY, attemptPath, attempts, callReply, calls, docIdOf, events, reviewName, reviewPath, sha256,
} from "@/test/gbp-reply-harness";
import { runGbpSyncSweep } from "@/lib/gbp/sync/sweep";
import { syncListing } from "@/lib/gbp/sync/run";
import { DELETE, POST } from "./route";

const ORIGINAL = { ...process.env };
const R6 = docIdOf("fake-r6");
const R7 = docIdOf("fake-r7");
const COMMENT = "  Sorry about the wait.\nWe've spoken to the team.  ";
const post = (body: unknown, docId = R6, uid = "uid_admin") => callReply(POST, "POST", uid, SA, docId, body);
const del = (docId = R7, uid = "uid_admin") => callReply(DELETE, "DELETE", uid, SA, docId);
/** The cached review minus the per-review in-flight lock, which must be released (null) again. */
function contentOf(reviewId: string) {
  const { replyInFlight, ...rest } = mem.read(reviewPath(reviewId)) ?? {};
  expect(replyInFlight ?? null).toBeNull();
  return rest;
}

beforeEach(async () => {
  resetSync();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await syncListing(SA, { trigger: "scheduled" });
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("posting", () => {
  it("posts exactly what the human typed, once, and records it without the text", async () => {
    const r = await post({ comment: COMMENT, idempotencyKey: KEY });
    expect(r.status).toBe(200);
    expect(r.body.reply?.comment).toBe(COMMENT);
    expect(calls()).toEqual([{ op: "putReply", reviewName: reviewName("fake-r6") }]);
    expect(mem.read(reviewPath("fake-r6"))?.reply).toEqual({ comment: COMMENT, updateTime: r.body.reply?.updateTime });

    const [attempt] = attempts();
    expect(attempt).toMatchObject({
      status: "succeeded", agencyId: AGENCY, subAccountId: SA, createdByUid: "uid_admin", reviewDocId: R6,
      commentHash: sha256(COMMENT),
    });
    const [event] = events(SA, "reply_posted");
    expect(event).toMatchObject({ actorUid: "uid_admin", createdByUid: "uid_admin", reviewDocId: R6, agencyId: AGENCY, subAccountId: SA });
    expect(events(SA, "reply_posted")).toHaveLength(1);
    for (const doc of [attempt, event]) expect(JSON.stringify(doc)).not.toContain("Sorry about the wait");
  });

  it("a retry with the same key returns the stored result and calls Google no more", async () => {
    const first = await post({ comment: COMMENT, idempotencyKey: KEY });
    const again = await post({ comment: COMMENT, idempotencyKey: KEY });
    expect(again.status).toBe(200);
    expect(again.body.reply).toEqual(first.body.reply);
    expect(calls()).toHaveLength(1);
    expect(events(SA, "reply_posted")).toHaveLength(1);
  });

  it("a late retry of an earlier submit never re-posts its text over a newer edit", async () => {
    await post({ comment: COMMENT, idempotencyKey: KEY });
    await post({ comment: "A newer edit.", idempotencyKey: "compose-session-key-0002" });
    const late = await post({ comment: COMMENT, idempotencyKey: KEY });
    expect(late.status).toBe(200);
    expect(calls()).toHaveLength(2);
    expect((mem.read(reviewPath("fake-r6"))?.reply as { comment: string }).comment).toBe("A newer edit.");
  });

  it("the same key with a different comment → 409 idempotency_key_reused, nothing posted", async () => {
    await post({ comment: COMMENT, idempotencyKey: KEY });
    const r = await post({ comment: "Something else", idempotencyKey: KEY });
    expect(r).toMatchObject({ status: 409, body: { code: "idempotency_key_reused" } });
    expect(calls()).toHaveLength(1);
    expect((mem.read(reviewPath("fake-r6"))?.reply as { comment: string }).comment).toBe(COMMENT);
  });

  it("the same key for a different review → 409 idempotency_key_reused", async () => {
    await post({ comment: COMMENT, idempotencyKey: KEY });
    const r = await post({ comment: COMMENT, idempotencyKey: KEY }, docIdOf("fake-r5"));
    expect(r).toMatchObject({ status: 409, body: { code: "idempotency_key_reused" } });
    expect(calls()).toHaveLength(1);
  });

  it("an attempt still pending (under two minutes) → 409 in_progress, no call", async () => {
    mem.seed(attemptPath(), {
      status: "pending", agencyId: AGENCY, subAccountId: SA, createdByUid: "uid_admin", reviewDocId: R6,
      commentHash: sha256(COMMENT), at: new Date(Date.now() - 60_000),
    });
    expect(await post({ comment: COMMENT, idempotencyKey: KEY })).toMatchObject({ status: 409, body: { code: "in_progress" } });
    expect(calls()).toEqual([]);
  });

  it("an attempt pending for over two minutes (a crashed request) is taken over", async () => {
    mem.seed(attemptPath(), {
      status: "pending", agencyId: AGENCY, subAccountId: SA, createdByUid: "uid_admin", reviewDocId: R6,
      commentHash: sha256(COMMENT), at: new Date(Date.now() - 3 * 60_000),
    });
    expect((await post({ comment: COMMENT, idempotencyKey: KEY })).status).toBe(200);
    expect(calls()).toHaveLength(1);
  });

  it("a reply already byte-equal on the review succeeds without a call", async () => {
    const r = await post({ comment: "Thank you from the fixture team.", idempotencyKey: KEY }, R7);
    expect(r.status).toBe(200);
    expect(r.body.reply?.comment).toBe("Thank you from the fixture team.");
    expect(calls()).toEqual([]);
    expect(attempts()[0]).toMatchObject({ status: "succeeded" });
  });

  it("a different reply on an already-replied review is posted — an edit", async () => {
    expect((await post({ comment: "Updated thanks.", idempotencyKey: KEY }, R7)).status).toBe(200);
    expect(calls()).toEqual([{ op: "putReply", reviewName: reviewName("fake-r7") }]);
  });
});

describe("failure", () => {
  it("leaves the review untouched, marks the attempt failed, and the same key may retry", async () => {
    setScenario(SA, (s) => void (s.failNext = { op: "putReply", kind: "transient" }));
    const before = contentOf("fake-r6");
    const r = await post({ comment: COMMENT, idempotencyKey: KEY });
    expect(r).toMatchObject({ status: 502, body: { code: "transient" } });
    expect(contentOf("fake-r6")).toEqual(before);
    expect(attempts()[0]).toMatchObject({ status: "failed", errorKind: "transient" });
    expect(events(SA, "reply_posted")).toEqual([]);

    expect((await post({ comment: COMMENT, idempotencyKey: KEY })).status).toBe(200);
    expect(calls()).toHaveLength(2);
  });

  it("a grant revoked at Google → 409 reconnect_required, the connection flagged, the review untouched", async () => {
    setScenario(SA, (s) => void (s.revoked = true));
    const before = contentOf("fake-r6");
    expect(await post({ comment: COMMENT, idempotencyKey: KEY })).toMatchObject({ status: 409, body: { code: "reconnect_required" } });
    expect(contentOf("fake-r6")).toEqual(before);
    expect(mem.read(`subAccounts/${SA}`)?.googleConnectionMeta).toMatchObject({ reconnectRequired: true });
    expect(attempts()[0]).toMatchObject({ status: "failed", errorKind: "revoked" });
  });
});

describe("the cache after a reply", () => {
  it("keeps the sync bookkeeping, and the next sync sees the review unchanged", async () => {
    mem.seed(reviewPath("fake-r6"), { ...mem.read(reviewPath("fake-r6"))!, missedPasses: 1 });
    const before = mem.read(reviewPath("fake-r6"))!;
    await post({ comment: COMMENT, idempotencyKey: KEY });
    const after = mem.read(reviewPath("fake-r6"))!;
    expect(after).toMatchObject({ missedPasses: 1, passId: before.passId, lastSeenAt: before.lastSeenAt, state: "active" });
    expect(after.contentHash).not.toBe(before.contentHash);

    const run = await syncListing(SA, { trigger: "scheduled" });
    expect(run).toMatchObject({ status: "success", created: 0, updated: 0, unchanged: 7 });
  });

  it("no sync, sweep or cron path ever calls putReply or deleteReply", async () => {
    await syncListing(SA, { trigger: "manual", actorUid: "uid_admin" });
    await syncListing(SA, { trigger: "scheduled" });
    await runGbpSyncSweep();
    expect(calls()).toEqual([]);
  });
});

describe("DELETE", () => {
  it("deletes the reply at Google once, clears it locally, and the next sync agrees", async () => {
    const r = await del();
    expect(r.status).toBe(200);
    expect(calls()).toEqual([{ op: "deleteReply", reviewName: reviewName("fake-r7") }]);
    expect(mem.read(reviewPath("fake-r7"))?.reply).toBeNull();
    expect(events(SA, "reply_deleted")[0]).toMatchObject({ actorUid: "uid_admin", reviewDocId: R7 });
    expect(await syncListing(SA, { trigger: "scheduled" })).toMatchObject({ updated: 0, unchanged: 7 });
  });

  it("refuses a collaborator — zero calls", async () => {
    expect((await del(R7, "uid_collab")).status).toBe(403);
    expect(calls()).toEqual([]);
  });

  it("a failure at Google leaves the local reply in place", async () => {
    setScenario(SA, (s) => void (s.failNext = { op: "deleteReply", kind: "transient" }));
    // DELETE takes and releases the same per-review lock as POST, so a clean
    // review picks up an explicit `replyInFlight: null` — nothing else moves.
    const before = { ...mem.read(reviewPath("fake-r7")), replyInFlight: null };
    expect(await del()).toMatchObject({ status: 502, body: { code: "transient" } });
    expect(mem.read(reviewPath("fake-r7"))).toEqual(before);
  });
});
