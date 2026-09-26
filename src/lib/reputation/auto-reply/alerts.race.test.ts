import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * A queued draft the run decides to move to approval, but which changed in
 * between (a Discard, a post) so the conversion writes nothing: it was not put
 * in front of a person by this run, so it is not counted in the held alert.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
vi.mock("./store", async (orig) => ({
  ...(await orig<typeof import("./store")>()),
  holdQueuedForApproval: async () => false,
}));

import { SA, mem } from "@/test/gbp-sync-harness";
import { A1, patchSettings, resetAutoReply, reviewDoc, sync } from "@/test/auto-reply-harness";
import { reviewBasis } from "@/lib/reputation/sentiment-basis";
import { autoReplyAlertsCollection } from "./alerts";
import { autoReplyAfterSync } from "./run";
import { textHashOf } from "./store";

const ORIGINAL = { ...process.env };

beforeEach(() => {
  resetAutoReply();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

it("the conversion to approval lost a race (nothing written) → not counted, no held alert", async () => {
  const run = await sync();
  const text = "Thank you for the five stars!";
  mem.seed(`subAccounts/${SA}/gbpReviews/${A1}`, {
    ...reviewDoc("fake-a1"),
    pendingReply: { text, textHash: textHashOf(text), basisHash: reviewBasis(reviewDoc("fake-a1")), reason: "auto_queued", model: "fake", at: new Date() },
  });
  patchSettings({ enabledAt: new Date("2026-08-30T00:00:00Z") });
  const tally = await autoReplyAfterSync(SA, run.startedAt, Date.now() + 240_000);
  expect(tally?.held).toBe(1);
  expect(tally?.newlyHeld).toBe(0);
  expect(mem.list(autoReplyAlertsCollection(SA))).toEqual([]);
});
