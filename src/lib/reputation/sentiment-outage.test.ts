import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * An AI outage or a revoked key (SP5 b round 4): a failed CALL stops the run
 * and spaces the retry by an hour, but never counts toward the three strikes
 * — so a long outage costs at most one call per run and never gives up on a
 * review. Only a bad answer from the model is a strike. Scripted AI double;
 * real sync, served set and in-memory Firestore; the clock is faked.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const script = vi.hoisted(() => ({ down: true, calls: 0 }));
vi.mock("./ai/select", () => ({
  getReviewsAiFor: async () => ({
    model: "scripted",
    classifySentiment: async (items: Array<{ id: string }>) => {
      script.calls++;
      return items.map((i) => (script.down ? { id: i.id, label: null, failure: "call_failed" } : { id: i.id, label: "neutral" }));
    },
  }),
}));

import { SA, mem, resetSync, reviews } from "@/test/gbp-sync-harness";
import { syncListing } from "@/lib/gbp/sync/run";
import { classifyPendingSentiment } from "./sentiment";
import { sentimentGaveUp } from "./sentiment-basis";
import { sentimentLeasePath } from "./sentiment-lease";

const ORIGINAL = { ...process.env };
const HOUR = 3600_000;
const T0 = new Date("2026-09-14T10:00:00Z");
const r7 = () => reviews().find((r) => r.reviewId === "fake-r7")!;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: T0 });
  resetSync();
  process.env.REVIEWS_AI_PROVIDER = "fake";
  process.env.REVIEWS_AI_FAKE_AGENCY_ID = "ag_1";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await syncListing(SA, { trigger: "scheduled" });
  mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, reviewsAiEnabledByAgency: true });
  Object.assign(script, { down: true, calls: 0 });
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a failed call (outage, revoked key, no credits)", () => {
  it("costs exactly one call per run, retries a review only after an hour, and never gives up on it", async () => {
    let runs = 0;
    for (let h = 0; h < 10; h++) {
      for (const minutes of [0, 30]) {
        vi.setSystemTime(new Date(T0.getTime() + h * HOUR + minutes * 60_000));
        const before = script.calls;
        expect(await classifyPendingSentiment(SA)).toMatchObject({ stopped: "ai_error", failed: 1 });
        expect(script.calls - before).toBe(1); // one call, then the run stops — never the backlog
        runs++;
      }
    }
    expect(script.calls).toBe(runs);
    // r7 was tried on the hour only (its retry waits an hour), and no strike ever counted.
    expect(r7().sentimentAttempt).toMatchObject({ failures: 0 });
    expect(sentimentGaveUp(r7() as Parameters<typeof sentimentGaveUp>[0])).toBe(false);
    expect(mem.read(sentimentLeasePath(SA))?.lastRun).toMatchObject({ reason: "ai_error" });
    // The provider comes back: the backlog is labelled.
    script.down = false;
    vi.setSystemTime(new Date(T0.getTime() + 11 * HOUR));
    expect(await classifyPendingSentiment(SA)).toMatchObject({ stopped: null, classified: 6 });
    expect(reviews().every((r) => r.sentiment)).toBe(true);
  });
});
