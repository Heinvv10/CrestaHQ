import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What happens around each AI call (SP5 b): the one-transaction `beginCall`
 * (lease owner, gates, listing, daily cap, the review itself, the strike),
 * the time budget, and the failure model: every failed call is a strike and
 * stops the run. The AI is a scripted double; the sync,
 * the served-reviews set and Firestore are real/in-memory. The clock is
 * faked (Date only) so the retry hour and the budget can be walked.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const script = vi.hoisted(() => ({
  onCall: null as null | ((ids: string[]) => void),
  fail: new Set<string>(),
  crash: false,
  refuse: false,
  calls: [] as string[][],
}));
vi.mock("./ai/select", () => ({
  getReviewsAiFor: async () => {
    if (script.refuse) throw new Error("provider refused");
    return {
    model: "scripted",
    classifySentiment: async (items: Array<{ id: string }>) => {
      script.calls.push(items.map((i) => i.id));
      script.onCall?.(items.map((i) => i.id));
      if (script.crash) throw new Error("process died mid-call");
      return items.map((i) => (script.fail.has(i.id) ? { id: i.id, label: null, failure: "bad_output" } : { id: i.id, label: "neutral" }));
    },
    };
  },
}));

import { SA, mem, resetSync, reviews } from "@/test/gbp-sync-harness";
import { syncListing } from "@/lib/gbp/sync/run";
import { classifyPendingSentiment, SENTIMENT_RUN_BUDGET_MS } from "./sentiment";
import { sentimentBasis, sentimentGaveUp } from "./sentiment-basis";
import { DAILY_AI_CALL_CAP, sentimentUsagePath } from "./sentiment-calls";
import { sentimentLeasePath } from "./sentiment-lease";

const ORIGINAL = { ...process.env };
const HOUR = 3600_000;
const T0 = new Date("2026-09-14T10:00:00Z");
const docOf = (reviewId: string) => reviews().find((r) => r.reviewId === reviewId)!;
const pathOf = (reviewId: string) => `subAccounts/${SA}/gbpReviews/${docOf(reviewId).id}`;
const sent = (docId: string) => script.calls.flat().filter((id) => id === docId).length;
const sub = () => mem.read(`subAccounts/${SA}`)!;
const lease = () => mem.read(sentimentLeasePath(SA)) ?? {};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: T0 });
  resetSync();
  process.env.REVIEWS_AI_PROVIDER = "fake";
  process.env.REVIEWS_AI_FAKE_AGENCY_ID = "ag_1";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await syncListing(SA, { trigger: "scheduled" });
  mem.seed(`subAccounts/${SA}`, { ...sub(), reviewsAiEnabledByAgency: true });
  Object.assign(script, { onCall: null, crash: false, refuse: false });
  script.fail.clear();
  script.calls.length = 0;
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("beginCall stops the run", () => {
  it.each([
    ["the Reviews AI gate is switched off", { reviewsAiEnabledByAgency: false }, "gate_off"],
    ["the Google gate is switched off", { googleEnabledByAgency: false }, "google_gate_off"],
  ])("when %s between two calls — the rest is skipped", async (_l, patch, reason) => {
    script.onCall = () => mem.seed(`subAccounts/${SA}`, { ...sub(), ...patch });
    const out = await classifyPendingSentiment(SA);
    expect(script.calls).toHaveLength(1);
    expect(out).toMatchObject({ stopped: reason, classified: 2, skipped: 5 }); // star-only + the one call
    expect(lease()).toMatchObject({ runId: null, lastRun: { reason } });
    expect(lease().lastCompleteAt).toBeUndefined(); // stopped early: not a complete run
  });

  it("when the listing changes between two calls", async () => {
    script.onCall = () =>
      mem.seed(`subAccounts/${SA}`, { ...sub(), googleListing: { ...(sub().googleListing as object), locationName: "locations/other" } });
    expect(await classifyPendingSentiment(SA)).toMatchObject({ stopped: "listing_changed" });
    expect(script.calls).toHaveLength(1);
  });

  it("when its lease was taken by another run (renewal is the owner's only)", async () => {
    script.onCall = () => mem.seed(sentimentLeasePath(SA), { ...lease(), runId: "another-run", until: Date.now() + 60_000 });
    expect(await classifyPendingSentiment(SA)).toMatchObject({ stopped: "lease_lost", classified: 2, skipped: 5 });
    expect(script.calls).toHaveLength(1);
  });

  it(`at the daily cap of ${DAILY_AI_CALL_CAP} calls, counted before each call`, async () => {
    mem.seed(sentimentUsagePath(SA), { day: "2026-09-14", calls: DAILY_AI_CALL_CAP - 2 });
    const out = await classifyPendingSentiment(SA);
    expect(script.calls).toHaveLength(2);
    expect(out).toMatchObject({ stopped: "daily_cap", skipped: 4 });
    expect(mem.read(sentimentUsagePath(SA))).toEqual({ day: "2026-09-14", calls: DAILY_AI_CALL_CAP });
    // The next UTC day starts a fresh count.
    vi.setSystemTime(new Date("2026-09-15T00:00:05Z"));
    await classifyPendingSentiment(SA);
    expect(mem.read(sentimentUsagePath(SA))).toEqual({ day: "2026-09-15", calls: 4 });
  });

  it("after the 240 s budget — no new call starts", async () => {
    script.onCall = () => vi.setSystemTime(new Date(Date.now() + SENTIMENT_RUN_BUDGET_MS + 1000));
    expect(await classifyPendingSentiment(SA)).toMatchObject({ stopped: "budget", classified: 2, skipped: 5 });
    expect(script.calls).toHaveLength(1);
  });
});

describe("beginCall drops a review", () => {
  it("edited before its call — not sent", async () => {
    const target = docOf("fake-r6").id;
    script.onCall = () => mem.seed(pathOf("fake-r6"), { ...mem.read(pathOf("fake-r6"))!, comment: "Edited before its turn." });
    expect(await classifyPendingSentiment(SA)).toMatchObject({ classified: 6, skipped: 1, stopped: null });
    expect(sent(target)).toBe(0);
  });

  it("labelled by another run meanwhile — not sent again", async () => {
    const target = docOf("fake-r2").id;
    script.onCall = () => {
      const d = mem.read(pathOf("fake-r2"))!;
      const basis = sentimentBasis(d.starRating as number, d.comment as string);
      mem.seed(pathOf("fake-r2"), { ...d, sentiment: { label: "negative", method: "ai", basisHash: basis, model: "other-run", at: new Date() } });
    };
    await classifyPendingSentiment(SA);
    expect(sent(target)).toBe(0);
  });
});

describe("the strike", () => {
  it("is written BEFORE the call and cleared by a label", async () => {
    const target = docOf("fake-r7").id;
    let during: unknown;
    script.onCall = (ids) => {
      if (ids.includes(target)) during = mem.read(pathOf("fake-r7"))?.sentimentAttempt;
    };
    await classifyPendingSentiment(SA);
    expect(during).toMatchObject({ failures: 1 });
    expect(docOf("fake-r7").sentimentAttempt).toBeNull();
    expect(docOf("fake-r7").sentiment).toMatchObject({ method: "ai" });
  });

  it("any failed call is a strike and STOPS the run — an outage costs one strike, not the backlog", async () => {
    const target = docOf("fake-r6").id; // the second text review, newest first
    script.fail.add(target);
    const out = await classifyPendingSentiment(SA);
    expect(out).toMatchObject({ stopped: "ai_error", classified: 2, failed: 1, skipped: 4 }); // star-only + r7, then r6 fails
    expect(script.calls).toHaveLength(2);
    expect(docOf("fake-r6").sentimentAttempt).toMatchObject({ failures: 1 });
    expect(lease()).toMatchObject({ lastRun: { reason: "ai_error" } });
    expect(lease().lastCompleteAt).toBeUndefined();
  });

  it("a provider that cannot be obtained stops the run (ai_error), not a complete run, nothing sent", async () => {
    script.refuse = true;
    expect(await classifyPendingSentiment(SA)).toMatchObject({ stopped: "ai_error", classified: 1, skipped: 6, failed: 0 });
    expect(script.calls).toHaveLength(0);
    expect(lease().lastCompleteAt).toBeUndefined();
  });

  it("a thrown call stops the run the same way", async () => {
    script.crash = true;
    // A throw inside the provider call is caught per call: strike kept, run stopped.
    const out = await classifyPendingSentiment(SA);
    expect(out).toMatchObject({ stopped: "ai_error", failed: 1 });
    expect(script.calls).toHaveLength(1);
  });

  it("retried at most once an hour and three times, then 'couldn't be analysed'", async () => {
    const target = docOf("fake-r2").id;
    script.fail.add(target);
    await classifyPendingSentiment(SA);
    expect(docOf("fake-r2").sentimentAttempt).toMatchObject({ failures: 1 });
    vi.setSystemTime(new Date(T0.getTime() + 10 * 60_000)); // within the hour: not sent
    await classifyPendingSentiment(SA);
    expect(sent(target)).toBe(1);
    for (const h of [1, 2]) {
      vi.setSystemTime(new Date(T0.getTime() + h * HOUR));
      await classifyPendingSentiment(SA);
    }
    expect(sent(target)).toBe(3);
    expect(sentimentGaveUp(docOf("fake-r2") as Parameters<typeof sentimentGaveUp>[0])).toBe(true);
    vi.setSystemTime(new Date(T0.getTime() + 5 * HOUR));
    await classifyPendingSentiment(SA);
    expect(sent(target)).toBe(3);
  });

  it("a crash outside the call (the store fails) keeps the strike, releases the lease with reason 'error', not complete", async () => {
    const { storeDb } = await import("@/test/gbp-sync-store");
    const real = storeDb.runTransaction.bind(storeDb);
    let n = 0;
    script.onCall = () => {
      vi.spyOn(storeDb, "runTransaction").mockImplementation((async (fn: never) => {
        if (++n === 1) throw new Error("14 UNAVAILABLE"); // finishCall's transaction
        return real(fn);
      }) as never);
    };
    const out = await classifyPendingSentiment(SA);
    expect(out).toMatchObject({ stopped: "ai_error", failed: 1 });
    expect(docOf("fake-r7").sentimentAttempt).toMatchObject({ failures: 1 });
    expect(lease().runId).toBeNull();
    expect(lease().lastCompleteAt).toBeUndefined();
  });

  it("an edit starts a new count (new content)", async () => {
    const target = docOf("fake-r2").id;
    script.fail.add(target);
    for (const h of [0, 1, 2]) {
      vi.setSystemTime(new Date(T0.getTime() + h * HOUR));
      await classifyPendingSentiment(SA);
    }
    mem.seed(pathOf("fake-r2"), { ...mem.read(pathOf("fake-r2"))!, comment: "New text." });
    script.fail.clear();
    await classifyPendingSentiment(SA);
    expect(sent(target)).toBe(4);
    expect(docOf("fake-r2").sentiment).toMatchObject({ method: "ai" });
  });
});

describe("during a call", () => {
  it("a review edited while it was being classified is not labelled from its old text", async () => {
    const target = docOf("fake-r6").id;
    script.onCall = (ids) => {
      if (ids.includes(target)) mem.seed(pathOf("fake-r6"), { ...mem.read(pathOf("fake-r6"))!, comment: "Edited while the model was thinking." });
    };
    expect(await classifyPendingSentiment(SA)).toMatchObject({ classified: 6, skipped: 1 });
    expect(docOf("fake-r6").sentiment).toBeUndefined();
  });
});
