import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Fix round 1 — concurrency and partial failure around the ONE provider call.
 *
 *  - A per-review in-flight lock (`replyInFlight` on the cached review, taken
 *    in the claim transaction): while one key's attempt is pending, a
 *    DIFFERENT key on the same review gets 409 in_progress with zero calls —
 *    otherwise abandoned text could go public (Google keeps the last write).
 *  - Google accepted but the local write failed: 200 {reply,
 *    localRecordPending: true}, never a 500 that reads "could not be posted".
 *  - Recording a failure must not mask the provider's error.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { SA, mem, resetSync, setScenario } from "@/test/gbp-sync-harness";
import { storeDb } from "@/test/gbp-sync-store";
import { KEY, attemptPath, attempts, callReply, calls, docIdOf, reviewPath, sha256 } from "@/test/gbp-reply-harness";
import { syncListing } from "@/lib/gbp/sync/run";
import { releaseLock } from "@/lib/gbp/reply-attempts";
import { DELETE, POST } from "./route";

const ORIGINAL = { ...process.env };
const R6 = docIdOf("fake-r6");
const R7 = docIdOf("fake-r7");
const K2 = "compose-session-key-0002";
const lockOf = (key: string) => sha256(key).slice(0, 40);
const post = (comment: string, key: string, docId = R6) => callReply(POST, "POST", "uid_admin", SA, docId, { comment, idempotencyKey: key });
const del = (docId = R7) => callReply(DELETE, "DELETE", "uid_admin", SA, docId);

/** An attempt for KEY on r6 still in flight, `ageMs` old: its ledger doc and the review's lock. */
function inFlight(ageMs: number) {
  const at = new Date(Date.now() - ageMs);
  mem.seed(attemptPath(), {
    status: "pending", agencyId: "ag_1", subAccountId: SA, createdByUid: "uid_admin", reviewDocId: R6,
    commentHash: sha256("First text."), at,
  });
  mem.seed(reviewPath("fake-r6"), { ...mem.read(reviewPath("fake-r6"))!, replyInFlight: { key: lockOf(KEY), at } });
}

/** Just the per-review lock (no ledger doc) — what a pending POST or DELETE leaves behind. */
function lockReview(reviewId: string, key: string, ageMs: number) {
  const at = new Date(Date.now() - ageMs);
  mem.seed(reviewPath(reviewId), { ...mem.read(reviewPath(reviewId))!, replyInFlight: { key: lockOf(key), at } });
}

/** Fail the Nth runTransaction (1 = the claim). */
function failTransaction(n: number) {
  const real = storeDb.runTransaction;
  let count = 0;
  vi.spyOn(storeDb, "runTransaction").mockImplementation(((fn: Parameters<typeof real>[0]) => {
    count += 1;
    if (count === n) return Promise.reject(new Error("firestore unavailable"));
    return real(fn);
  }) as typeof real);
}

beforeEach(async () => {
  resetSync();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await syncListing(SA, { trigger: "scheduled" });
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("the per-review in-flight lock", () => {
  it("another key's attempt pending on the same review → 409 in_progress, zero calls, nothing claimed", async () => {
    inFlight(60_000);
    expect(await post("Edited text.", K2)).toMatchObject({ status: 409, body: { code: "in_progress" } });
    expect(calls()).toEqual([]);
    expect(attempts()).toHaveLength(1);
  });

  it("a lock older than two minutes (a dead request) does not block", async () => {
    inFlight(3 * 60_000);
    expect((await post("Edited text.", K2)).status).toBe(200);
    expect(calls()).toHaveLength(1);
  });

  it("a lock on another review does not block this one", async () => {
    inFlight(60_000);
    expect((await post("Edited text.", K2, docIdOf("fake-r5"))).status).toBe(200);
  });

  it("is taken while the call is in flight and released on success", async () => {
    await post("First text.", KEY);
    expect(mem.read(reviewPath("fake-r6"))?.replyInFlight).toBeNull();
    expect((await post("Second text.", K2)).status).toBe(200);
    expect(calls()).toHaveLength(2);
  });

  it("is released on failure", async () => {
    setScenario(SA, (s) => void (s.failNext = { op: "putReply", kind: "transient" }));
    expect((await post("First text.", KEY)).status).toBe(502);
    expect(mem.read(reviewPath("fake-r6"))?.replyInFlight).toBeNull();
    expect((await post("Second text.", K2)).status).toBe(200);
  });

  it("DELETE takes the same lock: a pending POST on the review blocks it — 409 in_progress, zero delete calls", async () => {
    lockReview("fake-r7", KEY, 60_000);
    expect(await del()).toMatchObject({ status: 409, body: { code: "in_progress" } });
    expect(calls()).toEqual([]);
  });

  it("DELETE takes the lock and releases it on success", async () => {
    expect((await del()).status).toBe(200);
    expect(mem.read(reviewPath("fake-r7"))?.replyInFlight).toBeNull();
  });

  it("DELETE releases its lock on failure, and a POST on the same review may then proceed", async () => {
    setScenario(SA, (s) => void (s.failNext = { op: "deleteReply", kind: "transient" }));
    expect((await del()).status).toBe(502);
    expect(mem.read(reviewPath("fake-r7"))?.replyInFlight).toBeNull();
    expect((await post("A reply on r7.", K2, R7)).status).toBe(200);
  });

  it("releasing a lock never clears another key's lock on the same review", async () => {
    lockReview("fake-r6", K2, 30_000);
    await releaseLock(SA, R6, KEY);
    expect((mem.read(reviewPath("fake-r6")) as { replyInFlight?: { key?: string } }).replyInFlight?.key).toBe(lockOf(K2));
  });

  it("a pending DELETE on a review blocks a POST on it — 409 in_progress, zero calls", async () => {
    lockReview("fake-r7", "some-other-delete-lock", 60_000);
    expect(await post("Edited text.", K2, R7)).toMatchObject({ status: 409, body: { code: "in_progress" } });
    expect(calls()).toEqual([]);
  });
});

describe("the review vanishing between the lookup and the claim", () => {
  it("404s honestly, zero calls, nothing claimed", async () => {
    const real = storeDb.runTransaction;
    vi.spyOn(storeDb, "runTransaction").mockImplementationOnce((async (fn: Parameters<typeof real>[0]) => {
      // authorize() already loaded the review as a valid target; delete it
      // right before the claim transaction reads it, as a concurrent
      // listing-change sync would.
      await mem.db.doc(reviewPath("fake-r6")).delete();
      return real(fn);
    }) as typeof real);
    expect((await post("First text.", KEY)).status).toBe(404);
    expect(calls()).toEqual([]);
    expect(attempts()).toEqual([]);
  });
});

describe("the review vanishing between the lookup and a DELETE claim", () => {
  it("404s honestly (not a 500), zero delete calls", async () => {
    const real = storeDb.runTransaction;
    vi.spyOn(storeDb, "runTransaction").mockImplementationOnce((async (fn: Parameters<typeof real>[0]) => {
      await mem.db.doc(reviewPath("fake-r7")).delete();
      return real(fn);
    }) as typeof real);
    expect(await del()).toMatchObject({ status: 404, body: { code: "not_found" } });
    expect(calls()).toEqual([]);
  });
});

describe("partial failure", () => {
  it("Google accepted but the local write failed → 200 localRecordPending; a same-key retry makes no call", async () => {
    failTransaction(2);
    const r = await post("First text.", KEY);
    expect(r).toMatchObject({ status: 200, body: { localRecordPending: true, reply: { comment: "First text." } } });
    expect(calls()).toHaveLength(1);
    expect(mem.read(attemptPath())).toMatchObject({ status: "succeeded" });
    // The lock recordReplyChange would have released was never committed —
    // it must still be cleared, so a DIFFERENT key can post right away.
    expect(mem.read(reviewPath("fake-r6"))?.replyInFlight).toBeNull();
    expect((await post("Second text.", K2)).status).toBe(200);
    expect(calls()).toHaveLength(2);
    vi.mocked(storeDb.runTransaction).mockRestore();
    expect((await post("First text.", KEY)).status).toBe(200);
    expect(calls()).toHaveLength(2);
  });

  it("a DELETE Google accepted but not recorded locally → 200 localRecordPending", async () => {
    // 1 = DELETE's own claim of the per-review lock; 2 = recordReplyChange.
    failTransaction(2);
    const r = await callReply(DELETE, "DELETE", "uid_admin", SA, docIdOf("fake-r7"));
    expect(r).toMatchObject({ status: 200, body: { ok: true, localRecordPending: true } });
    expect(calls()).toEqual([{ op: "deleteReply", reviewName: expect.stringContaining("fake-r7") }]);
    expect(mem.read(reviewPath("fake-r7"))?.replyInFlight).toBeNull();
  });

  it("recording a failure that itself fails still answers with the provider's error", async () => {
    setScenario(SA, (s) => void (s.failNext = { op: "putReply", kind: "transient" }));
    failTransaction(2);
    expect(await post("First text.", KEY)).toMatchObject({ status: 502, body: { code: "transient" } });
  });
});
