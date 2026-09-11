import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * recordReplyChange — what lands after Google accepted a reply. A listing
 * change can clear the review cache while a reply is in flight; the reply
 * must never recreate a review (or revive a tombstone), but the audit event
 * is still written.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { AGENCY, SA, mem, resetSync } from "@/test/gbp-sync-harness";
import { docIdOf, events, reviewPath } from "@/test/gbp-reply-harness";
import { syncListing } from "@/lib/gbp/sync/run";
import { claimAttempt, failAttempt, recordReplyChange } from "./reply-attempts";

const ORIGINAL = { ...process.env };
const REPLY = { comment: "Thanks from the fixture team.", updateTime: "2026-09-11T10:00:00Z" };
const TARGET = { docId: docIdOf("fake-r6"), agencyId: AGENCY };
const record = () =>
  recordReplyChange(SA, TARGET, REPLY, {
    type: "reply_posted", actorUid: "uid_admin", key: null, now: new Date(),
  });

beforeEach(async () => {
  resetSync();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await syncListing(SA, { trigger: "scheduled" });
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("recordReplyChange", () => {
  it("does not recreate a review whose cache was cleared meanwhile — the event is still recorded", async () => {
    await mem.db.doc(reviewPath("fake-r6")).delete();
    await record();
    expect(mem.read(reviewPath("fake-r6"))).toBeUndefined();
    expect(events(SA, "reply_posted")).toHaveLength(1);
  });

  it("leaves a tombstone a tombstone", async () => {
    mem.seed(reviewPath("fake-r6"), { ...mem.read(reviewPath("fake-r6"))!, state: "removed", reply: null, contentHash: null });
    await record();
    expect(mem.read(reviewPath("fake-r6"))).toMatchObject({ state: "removed", reply: null, contentHash: null });
  });

  it("releases only its own in-flight lock — never another key's (success and failure)", async () => {
    const other = { key: "b".repeat(40), at: new Date() };
    mem.seed(reviewPath("fake-r6"), { ...mem.read(reviewPath("fake-r6"))!, replyInFlight: other });
    await recordReplyChange(SA, TARGET, REPLY, { type: "reply_posted", actorUid: "uid_admin", key: "compose-session-key-0001", now: new Date() });
    expect(mem.read(reviewPath("fake-r6"))?.replyInFlight).toEqual(other);
    await failAttempt(SA, TARGET, "compose-session-key-0001", "transient");
    expect(mem.read(reviewPath("fake-r6"))?.replyInFlight).toEqual(other);
  });
});

describe("claimAttempt", () => {
  it("the review vanishing between loadReplyTarget's lookup and the claim → gone, nothing written", async () => {
    await mem.db.doc(reviewPath("fake-r6")).delete();
    const claim = await claimAttempt(
      SA, TARGET, { comment: "Thanks.", idempotencyKey: "compose-session-key-0003" }, "uid_admin", new Date(),
    );
    expect(claim).toEqual({ kind: "gone" });
    expect(mem.read(`subAccounts/${SA}/gbpReplyAttempts/${TARGET.docId}`)).toBeUndefined();
    expect(mem.list(`subAccounts/${SA}/gbpReplyAttempts`)).toEqual([]);
  });
});
