import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What happens between the AI call and the write: a review edited while it
 * was being classified is not labelled from its old text, and an item the
 * model did not validly answer stays unlabelled for the next run. The AI is
 * a scripted double here (the fence and the real classifier have their own
 * tests); the sync, the served-reviews set and Firestore are real/in-memory.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const script = vi.hoisted(() => ({
  onCall: null as null | ((ids: string[]) => void),
  drop: new Set<string>(),
  calls: [] as string[][],
}));
vi.mock("./ai/select", () => ({
  getReviewsAiFor: async () => ({
    model: "scripted",
    classifySentiment: async (items: Array<{ id: string }>) => {
      script.calls.push(items.map((i) => i.id));
      script.onCall?.(items.map((i) => i.id));
      return items.filter((i) => !script.drop.has(i.id)).map((i) => ({ id: i.id, label: "neutral" }));
    },
  }),
}));

import { SA, mem, resetSync, reviews } from "@/test/gbp-sync-harness";
import { syncListing } from "@/lib/gbp/sync/run";
import { classifyPendingSentiment } from "./sentiment";

const ORIGINAL = { ...process.env };
const docOf = (reviewId: string) => reviews().find((r) => r.reviewId === reviewId)!;

beforeEach(async () => {
  resetSync();
  process.env.REVIEWS_AI_PROVIDER = "fake";
  process.env.REVIEWS_AI_FAKE_AGENCY_ID = "ag_1";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await syncListing(SA, { trigger: "scheduled" });
  const sub = mem.read(`subAccounts/${SA}`)!;
  mem.seed(`subAccounts/${SA}`, { ...sub, reviewsAiEnabledByAgency: true });
  script.onCall = null;
  script.drop.clear();
  script.calls.length = 0;
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("between the call and the write", () => {
  it("a review edited mid-flight is discarded, not labelled from its old text", async () => {
    const target = docOf("fake-r6").id;
    const path = `subAccounts/${SA}/gbpReviews/${target}`;
    script.onCall = () => mem.seed(path, { ...mem.read(path)!, comment: "Edited while the model was thinking." });
    const out = await classifyPendingSentiment(SA);
    expect(out).toMatchObject({ classified: 6, skipped: 1, failed: 0 });
    expect(mem.read(path)?.sentiment).toBeUndefined();
    // Next run sends the edited text once.
    script.onCall = null;
    await classifyPendingSentiment(SA);
    expect(script.calls.flat().filter((id) => id === target)).toHaveLength(2);
    expect(mem.read(path)?.sentiment).toMatchObject({ method: "ai" });
  });

  it("a review tombstoned mid-flight is not labelled", async () => {
    const target = docOf("fake-r7").id;
    const path = `subAccounts/${SA}/gbpReviews/${target}`;
    script.onCall = () => mem.seed(path, { ...mem.read(path)!, state: "removed", comment: null, starRating: null, sentiment: null });
    await classifyPendingSentiment(SA);
    expect(mem.read(path)?.sentiment).toBeNull();
  });

  it("an item the model did not validly answer stays unlabelled and is retried next run", async () => {
    const target = docOf("fake-r2").id;
    script.drop.add(target);
    expect(await classifyPendingSentiment(SA)).toMatchObject({ classified: 6, skipped: 0, failed: 1 });
    expect(docOf("fake-r2").sentiment).toBeUndefined();
    script.drop.clear();
    expect(await classifyPendingSentiment(SA)).toMatchObject({ classified: 1, failed: 0 });
    expect(script.calls.at(-1)).toEqual([target]);
  });
});
