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
import { recordReplyChange } from "./reply-attempts";

const ORIGINAL = { ...process.env };
const REPLY = { comment: "Thanks from the fixture team.", updateTime: "2026-09-11T10:00:00Z" };
const record = () =>
  recordReplyChange(SA, { docId: docIdOf("fake-r6"), agencyId: AGENCY }, REPLY, {
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
});
