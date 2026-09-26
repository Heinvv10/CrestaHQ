import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * storePending — a draft is stored only on the review it was made for: still
 * active, unreplied, the same basis, and not Discarded meanwhile (either
 * marker). And beginDraftCall's auto share is enforced inside its own
 * transaction, whatever the caller's count said.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { SA, mem } from "@/test/gbp-sync-harness";
import { reviewPath } from "@/test/gbp-reply-harness";
import { A1, resetAutoReply, sync } from "@/test/auto-reply-harness";
import { beginDraftCall } from "@/lib/reputation/draft";
import { sentimentBasis } from "@/lib/reputation/sentiment-basis";
import { sentimentUsagePath } from "@/lib/reputation/sentiment-calls";
import { autoReplyDismissedCollection, storePending } from "./store";

const ORIGINAL = { ...process.env };
const BASIS = sentimentBasis(5, null);
const store = () => storePending(SA, A1, { text: "Thanks!", basisHash: BASIS, reason: "auto_queued", model: "fake" }, new Date());
const patchReview = (patch: Record<string, unknown>) => mem.seed(reviewPath("fake-a1"), { ...mem.read(reviewPath("fake-a1"))!, ...patch });
const pendingNow = () => mem.read(reviewPath("fake-a1"))!.pendingReply as Record<string, unknown> | null | undefined;

beforeEach(async () => {
  resetAutoReply();
  await sync();
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

it("stores the draft with its text hash", async () => {
  expect(await store()).toBe(true);
  expect(pendingNow()).toMatchObject({ text: "Thanks!", basisHash: BASIS, reason: "auto_queued", model: "fake", textHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
});

it.each<[string, () => void]>([
  ["a reply landed", () => patchReview({ reply: { comment: "Human.", updateTime: "2026-09-01T00:00:00Z" } })],
  ["the review was removed", () => patchReview({ state: "removed" })],
  ["the review changed", () => patchReview({ starRating: 4 })],
  ["it was Discarded (pendingReply)", () => patchReview({ pendingReply: { reason: "dismissed", basisHash: BASIS, text: null, textHash: null } })],
  ["it was Discarded (the set outside the cache)", () => mem.seed(`${autoReplyDismissedCollection(SA)}/${A1}`, { basisHash: BASIS })],
])("refuses when %s", async (_l, change) => {
  change();
  const before = pendingNow();
  expect(await store()).toBe(false);
  expect(pendingNow()).toEqual(before);
});

it("a Discard of an older basis does not block the changed review", async () => {
  mem.seed(`${autoReplyDismissedCollection(SA)}/${A1}`, { basisHash: "old" });
  expect(await store()).toBe(true);
});

it("beginDraftCall refuses the 41st auto draft in its own transaction; a human draft still goes", async () => {
  const day = new Date().toISOString().slice(0, 10);
  mem.seed(sentimentUsagePath(SA), { day, calls: 40, draftsDay: day, draftCalls: 40, autoDraftCalls: 40 });
  expect(await beginDraftCall(SA, { auto: true })).toBe("auto_draft_cap");
  expect(mem.read(sentimentUsagePath(SA))).toMatchObject({ calls: 40, draftCalls: 40, autoDraftCalls: 40 });
  expect(await beginDraftCall(SA)).toBeNull();
  expect(mem.read(sentimentUsagePath(SA))).toMatchObject({ calls: 41, draftCalls: 41, autoDraftCalls: 40 });
});
