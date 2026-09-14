import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What happens around each AI call: a review that changed, was removed or
 * got labelled before its call is not sent; one that changed DURING its call
 * is not labelled from the old text; a lost lease stops the run; an item the
 * model did not validly answer records a failed attempt — retried at most
 * once an hour and three times per content. The AI is a scripted double; the
 * sync, the served-reviews set and Firestore are real/in-memory.
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
import { sentimentBasis, sentimentGaveUp } from "./sentiment-basis";
import { sentimentLeasePath } from "./sentiment-lease";

const ORIGINAL = { ...process.env };
const HOUR = 3600_000;
const docOf = (reviewId: string) => reviews().find((r) => r.reviewId === reviewId)!;
const pathOf = (reviewId: string) => `subAccounts/${SA}/gbpReviews/${docOf(reviewId).id}`;
const sent = (docId: string) => script.calls.flat().filter((id) => id === docId).length;

beforeEach(async () => {
  resetSync();
  process.env.REVIEWS_AI_PROVIDER = "fake";
  process.env.REVIEWS_AI_FAKE_AGENCY_ID = "ag_1";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await syncListing(SA, { trigger: "scheduled" });
  mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, reviewsAiEnabledByAgency: true });
  script.onCall = null;
  script.drop.clear();
  script.calls.length = 0;
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("before each call", () => {
  it("a review edited before its call is not sent (re-read right before the call)", async () => {
    const target = docOf("fake-r6").id;
    script.onCall = () => mem.seed(pathOf("fake-r6"), { ...mem.read(pathOf("fake-r6"))!, comment: "Edited before its turn." });
    const out = await classifyPendingSentiment(SA);
    expect(sent(target)).toBe(0);
    expect(out).toMatchObject({ classified: 6, skipped: 1, failed: 0 }); // 1 star-only + 5 text
    script.onCall = null;
    await classifyPendingSentiment(SA);
    expect(sent(target)).toBe(1); // the edited text, once
  });

  it("a review another run labelled meanwhile is not sent again", async () => {
    const target = docOf("fake-r2").id;
    script.onCall = () => {
      const d = mem.read(pathOf("fake-r2"))!;
      const basis = sentimentBasis(d.starRating as number, d.comment as string);
      mem.seed(pathOf("fake-r2"), { ...d, sentiment: { label: "negative", method: "ai", basisHash: basis, model: "other-run", at: new Date() } });
    };
    await classifyPendingSentiment(SA);
    expect(sent(target)).toBe(0);
    expect(docOf("fake-r2").sentiment).toMatchObject({ model: "other-run" });
  });

  it("a lost lease stops the run: renewal refuses once another run holds it", async () => {
    script.onCall = () =>
      mem.seed(sentimentLeasePath(SA), { ...mem.read(sentimentLeasePath(SA)), runId: "another-run", until: Date.now() + 60_000 });
    const out = await classifyPendingSentiment(SA);
    expect(script.calls).toHaveLength(1);
    expect(out).toMatchObject({ classified: 2, skipped: 5 }); // the star-only label + the one call
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

  it("a review tombstoned during its call is not labelled", async () => {
    const target = docOf("fake-r7").id;
    script.onCall = (ids) => {
      if (ids.includes(target)) mem.seed(pathOf("fake-r7"), { ...mem.read(pathOf("fake-r7"))!, state: "removed", comment: null, starRating: null, sentiment: null });
    };
    await classifyPendingSentiment(SA);
    expect(docOf("fake-r7").sentiment).toBeNull();
  });
});

describe("failed analyses", () => {
  it("are recorded per content, retried at most once an hour and three times, then 'couldn't be analysed'", async () => {
    const target = docOf("fake-r2").id;
    script.drop.add(target);
    const t0 = Date.now();
    expect(await classifyPendingSentiment(SA, { now: new Date(t0) })).toMatchObject({ classified: 6, failed: 1 });
    expect(docOf("fake-r2").sentimentAttempt).toMatchObject({ failures: 1 });
    await classifyPendingSentiment(SA, { now: new Date(t0 + 10 * 60_000) }); // within the hour: not sent
    expect(sent(target)).toBe(1);
    await classifyPendingSentiment(SA, { now: new Date(t0 + HOUR) });
    await classifyPendingSentiment(SA, { now: new Date(t0 + 2 * HOUR) });
    expect(sent(target)).toBe(3);
    expect(docOf("fake-r2").sentimentAttempt).toMatchObject({ failures: 3 });
    expect(sentimentGaveUp(docOf("fake-r2") as Parameters<typeof sentimentGaveUp>[0])).toBe(true);
    await classifyPendingSentiment(SA, { now: new Date(t0 + 5 * HOUR) }); // given up: never again for this content
    expect(sent(target)).toBe(3);
  });

  it("an edit resets the count (new content), and a success clears the attempt", async () => {
    const target = docOf("fake-r2").id;
    script.drop.add(target);
    const t0 = Date.now();
    for (let h = 0; h < 3; h++) await classifyPendingSentiment(SA, { now: new Date(t0 + h * HOUR) });
    mem.seed(pathOf("fake-r2"), { ...mem.read(pathOf("fake-r2"))!, comment: "New text." });
    script.drop.clear();
    await classifyPendingSentiment(SA, { now: new Date(t0 + 3 * HOUR) });
    expect(sent(target)).toBe(4);
    expect(docOf("fake-r2").sentiment).toMatchObject({ method: "ai" });
    expect(docOf("fake-r2").sentimentAttempt).toBeNull();
  });
});
