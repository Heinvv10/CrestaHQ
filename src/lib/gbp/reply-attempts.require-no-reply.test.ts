import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `requireNoReply` (AUTO_REPLY_V1_PLAN.md) — the auto-reply engine's claim
 * never posts over an existing reply, whoever wrote it; the human's explicit
 * reply is unchanged and still edits one (the route's own "a different reply
 * on an already-replied review is posted — an edit" test covers the route).
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { AGENCY, SA, mem, resetSync } from "@/test/gbp-sync-harness";
import { attempts, calls, docIdOf, events, reviewPath } from "@/test/gbp-reply-harness";
import { syncListing } from "@/lib/gbp/sync/run";
import { loadReplyTarget, postReply } from "./reply";
import { claimAttempt } from "./reply-attempts";

const ORIGINAL = { ...process.env };
const R7 = docIdOf("fake-r7"); // replied: "Thank you from the fixture team."
const R6 = docIdOf("fake-r6"); // unreplied
const BODY = { comment: "An automatic thank-you.", idempotencyKey: "auto:key-0001" };
const PENDING = { text: "An automatic thank-you.", textHash: "h", basisHash: "b", reason: "auto_queued", at: new Date(), model: "fake" };

beforeEach(async () => {
  resetSync();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await syncListing(SA, { trigger: "scheduled" });
  mem.seed(reviewPath("fake-r7"), { ...mem.read(reviewPath("fake-r7"))!, pendingReply: PENDING });
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("claimAttempt", () => {
  it("with requireNoReply, a replied review is already_replied: no attempt, no lock, pendingReply cleared", async () => {
    const claim = await claimAttempt(SA, { docId: R7, agencyId: AGENCY }, BODY, "uid_admin", new Date(), { requireNoReply: true });
    expect(claim).toEqual({ kind: "already_replied" });
    expect(attempts()).toEqual([]);
    const doc = mem.read(reviewPath("fake-r7"))!;
    expect(doc.pendingReply).toBeNull();
    expect(doc.replyInFlight ?? null).toBeNull();
    expect((doc.reply as { comment: string }).comment).toBe("Thank you from the fixture team.");
  });

  it("with requireNoReply, an unreplied review is claimed as usual", async () => {
    const claim = await claimAttempt(SA, { docId: R6, agencyId: AGENCY }, BODY, "uid_admin", new Date(), { requireNoReply: true });
    expect(claim).toEqual({ kind: "new" });
  });

  it("without it (the human path), a replied review is still claimed — an edit", async () => {
    const claim = await claimAttempt(SA, { docId: R7, agencyId: AGENCY }, BODY, "uid_admin", new Date());
    expect(claim).toEqual({ kind: "new" });
    expect(mem.read(reviewPath("fake-r7"))!.pendingReply).toEqual(PENDING);
  });
});

describe("postReply", () => {
  it("an auto post over an existing reply is skipped: 200 {skipped}, Google never called", async () => {
    const target = (await loadReplyTarget(SA, R7))!;
    const res = await postReply(SA, target, BODY, "system:auto-reply", { createdByUid: "uid_admin" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: "already_replied" });
    expect(calls()).toEqual([]);
    expect(events(SA, "reply_posted")).toEqual([]);
  });

  it("the human post over the same review still posts (unchanged)", async () => {
    const target = (await loadReplyTarget(SA, R7))!;
    const res = await postReply(SA, target, BODY, "uid_admin");
    expect(res.status).toBe(200);
    expect(calls()).toHaveLength(1);
    const doc = mem.read(reviewPath("fake-r7"))!;
    expect(doc.pendingReply).toBeNull();
    expect(doc.autoReplied).toBeUndefined();
    expect(events(SA, "reply_posted")[0]).toMatchObject({ actorUid: "uid_admin", createdByUid: "uid_admin" });
  });
});
