import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `requireNoReply` (AUTO_REPLY_V1_PLAN.md) — the auto-reply engine's claim
 * never posts to a review that has or ever had a reply (whoever wrote it),
 * and only the queued bytes (`textHash`) of a star still set to Auto; the
 * human's explicit reply is unchanged and still edits one (the route's own
 * "a different reply on an already-replied review is posted — an edit" test
 * covers the route).
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { AGENCY, SA, mem, resetSync } from "@/test/gbp-sync-harness";
import { attempts, calls, docIdOf, events, reviewPath } from "@/test/gbp-reply-harness";
import { neverPath } from "@/test/auto-reply-harness";
import { syncListing } from "@/lib/gbp/sync/run";
import { loadReplyTarget, postReply } from "./reply";
import { claimAttempt } from "./reply-attempts";

const ORIGINAL = { ...process.env };
const R7 = docIdOf("fake-r7"); // 5★, replied: "Thank you from the fixture team."
const R4 = docIdOf("fake-r4"); // 5★, unreplied
const BODY = { comment: "An automatic thank-you.", idempotencyKey: "auto:key-0001" };
const HASH = "h".repeat(64);
const PENDING = { text: BODY.comment, textHash: HASH, basisHash: "b", reason: "auto_queued", at: new Date(), model: "fake" };
const MODES = { 1: "approval", 2: "approval", 3: "approval", 4: "auto", 5: "auto" };
const auto = (docId: string, textHash = HASH) =>
  claimAttempt(SA, { docId, agencyId: AGENCY }, BODY, "system:auto-reply", new Date(), { requireNoReply: { textHash }, createdByUid: "uid_admin" });
const patch = (reviewId: string, p: Record<string, unknown>) => mem.seed(reviewPath(reviewId), { ...mem.read(reviewPath(reviewId))!, ...p });

beforeEach(async () => {
  resetSync();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await syncListing(SA, { trigger: "scheduled" });
  mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, reviewsAutoReply: { enabled: true, modes: MODES, includeBacklog: true } });
  patch("fake-r7", { pendingReply: PENDING });
  patch("fake-r4", { pendingReply: PENDING });
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("claimAttempt with requireNoReply", () => {
  it("a replied review is already_replied: no attempt, no lock, pendingReply cleared", async () => {
    expect(await auto(R7)).toEqual({ kind: "already_replied" });
    expect(attempts()).toEqual([]);
    const doc = mem.read(reviewPath("fake-r7"))!;
    expect(doc.pendingReply).toBeNull();
    expect(doc.replyInFlight ?? null).toBeNull();
    expect((doc.reply as { comment: string }).comment).toBe("Thank you from the fixture team.");
  });

  it("a review with an autoReplyNever marker (outside the cache) is already_replied", async () => {
    mem.seed(neverPath("fake-r4"), { reason: "replied" });
    expect(await auto(R4)).toEqual({ kind: "already_replied" });
  });

  it("a review whose reply was deleted (hadReply) is already_replied too", async () => {
    patch("fake-r4", { hadReply: true });
    expect(await auto(R4)).toEqual({ kind: "already_replied" });
  });

  it("an unreplied review with these queued bytes on an Auto star is claimed; the attempt names the enabler and the system actor", async () => {
    expect(await auto(R4)).toEqual({ kind: "new" });
    expect(attempts()[0]).toMatchObject({ createdByUid: "uid_admin", actorUid: "system:auto-reply", agencyId: AGENCY, subAccountId: SA });
  });

  it.each<[string, () => void, string?]>([
    ["other stored bytes", () => undefined, "x".repeat(64)],
    ["Discarded", () => patch("fake-r4", { pendingReply: { ...PENDING, reason: "dismissed" } })],
    ["now held for approval", () => patch("fake-r4", { pendingReply: { ...PENDING, reason: "approval" } })],
    ["no draft", () => patch("fake-r4", { pendingReply: null })],
    ["its star switched to Approval", () => mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, reviewsAutoReply: { enabled: true, modes: { ...MODES, 5: "approval" }, includeBacklog: true } })],
  ])("%s → not_queued, nothing claimed", async (_l, change, textHash) => {
    change();
    expect(await auto(R4, textHash)).toEqual({ kind: "not_queued" });
    expect(attempts()).toEqual([]);
  });

  it("a post_failed draft (retried once a day) is still claimable", async () => {
    patch("fake-r4", { pendingReply: { ...PENDING, reason: "post_failed" } });
    expect(await auto(R4)).toEqual({ kind: "new" });
  });

  it("without it (the human path), a replied review is still claimed — an edit; the actor is the tenant anchor", async () => {
    const claim = await claimAttempt(SA, { docId: R7, agencyId: AGENCY }, BODY, "uid_admin", new Date());
    expect(claim).toEqual({ kind: "new" });
    expect(mem.read(reviewPath("fake-r7"))!.pendingReply).toEqual(PENDING);
    expect(attempts()[0]).toMatchObject({ createdByUid: "uid_admin", actorUid: "uid_admin" });
  });
});

describe("postReply", () => {
  it("a human post to a never-replied review stamps hadReply and the marker", async () => {
    const res = await postReply(SA, (await loadReplyTarget(SA, R4))!, BODY, "uid_admin");
    expect(res.status).toBe(200);
    expect(mem.read(reviewPath("fake-r4"))!.hadReply).toBe(true);
    expect(mem.read(neverPath("fake-r4"))).toMatchObject({ reason: "replied", createdByUid: "uid_admin", agencyId: AGENCY });
  });

  it("an auto post over an existing reply is skipped: 200 {skipped}, Google never called", async () => {
    const target = (await loadReplyTarget(SA, R7))!;
    const res = await postReply(SA, target, BODY, "system:auto-reply", { createdByUid: "uid_admin", textHash: HASH });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ skipped: "already_replied" });
    expect(calls()).toEqual([]);
    expect(events(SA, "reply_posted")).toEqual([]);
  });

  it("the human post over the same review still posts (unchanged), and marks it hadReply for good", async () => {
    const target = (await loadReplyTarget(SA, R7))!;
    const res = await postReply(SA, target, BODY, "uid_admin");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ reply: expect.objectContaining({ comment: BODY.comment }) });
    expect(calls()).toHaveLength(1);
    const doc = mem.read(reviewPath("fake-r7"))!;
    expect(doc.pendingReply).toBeNull();
    expect(doc.hadReply).toBe(true);
    expect(doc.autoReplied).toBeUndefined();
    expect(events(SA, "reply_posted")[0]).toMatchObject({ actorUid: "uid_admin", createdByUid: "uid_admin" });
  });
});
