import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Failure CAUSE, end to end through the real OpenRouter seam (SP5 b round 5):
 * callAi is the only double. A review the provider always rejects (403) or
 * answers with nothing is a strike each time — given up after 3 runs an hour
 * apart — and, because tried reviews queue AFTER fresh ones, it never blocks
 * the older reviews. A transient failure (429) is never a strike.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const script = vi.hoisted(() => ({ badText: "", error: "", calls: [] as string[] }));
vi.mock("@/lib/comms/ai/openrouter", () => ({
  aiIsConfigured: () => true,
  defaultAiModel: () => "m",
  callAi: async ({ messages }: { messages: Array<{ content: string }> }) => {
    const text = JSON.parse(messages[1].content).reviews[0].text as string;
    script.calls.push(text);
    if (text === script.badText) throw new Error(script.error);
    return { text: JSON.stringify({ results: [{ id: "1", label: "neutral" }] }), model: "m", promptTokens: 1, completionTokens: 1, totalTokens: 2 };
  },
}));

import { SA, mem, resetSync, reviews } from "@/test/gbp-sync-harness";
import { syncListing } from "@/lib/gbp/sync/run";
import { classifyPendingSentiment } from "./sentiment";
import { sentimentGaveUp } from "./sentiment-basis";

const ORIGINAL = { ...process.env };
const HOUR = 3600_000;
const T0 = new Date("2026-09-14T10:00:00Z");
const byId = (rid: string) => reviews().find((r) => r.reviewId === rid)!;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: T0 });
  resetSync();
  delete process.env.REVIEWS_AI_PROVIDER;
  process.env.OPENROUTER_API_KEY = "sk-test";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await syncListing(SA, { trigger: "scheduled" });
  mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, reviewsAiEnabledByAgency: true });
  script.calls.length = 0;
  script.badText = byId("fake-r7").comment as string; // the NEWEST review — first in line
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a review the provider always rejects", () => {
  it.each([
    ["403 (moderation)", "OpenRouter 403: flagged"],
    ["a 200 with no content", "OpenRouter returned no message content"],
  ])("%s: a strike per run, given up after three runs an hour apart — the older reviews still get labelled", async (_l, error) => {
    script.error = error;
    for (const h of [0, 1, 2]) {
      vi.setSystemTime(new Date(T0.getTime() + h * HOUR));
      await classifyPendingSentiment(SA);
    }
    expect(byId("fake-r7").sentimentAttempt).toMatchObject({ failures: 3 });
    expect(sentimentGaveUp(byId("fake-r7") as Parameters<typeof sentimentGaveUp>[0])).toBe(true);
    for (const rid of ["fake-r6", "fake-r5", "fake-r4", "fake-r2", "fake-r1"]) expect(byId(rid).sentiment).toMatchObject({ method: "ai" });
    expect(script.calls.filter((t) => t === script.badText)).toHaveLength(3);
    // Given up: never sent again.
    vi.setSystemTime(new Date(T0.getTime() + 5 * HOUR));
    await classifyPendingSentiment(SA);
    expect(script.calls.filter((t) => t === script.badText)).toHaveLength(3);
  });
});

describe("a transient failure", () => {
  it("429: never a strike — the run stops, the review waits an hour, fresh reviews go first next time", async () => {
    script.error = "OpenRouter 429: slow down";
    expect(await classifyPendingSentiment(SA)).toMatchObject({ stopped: "ai_error" });
    expect(byId("fake-r7").sentimentAttempt).toMatchObject({ failures: 0 });
    vi.setSystemTime(new Date(T0.getTime() + HOUR));
    expect(await classifyPendingSentiment(SA)).toMatchObject({ classified: 5, stopped: "ai_error" }); // the 5 fresh ones, then r7 again
    expect(sentimentGaveUp(byId("fake-r7") as Parameters<typeof sentimentGaveUp>[0])).toBe(false);
  });
});
