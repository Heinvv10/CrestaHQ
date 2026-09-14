import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Review sentiment (SP5 b) over the REAL sync (fake GBP provider) and the
 * REAL fenced Reviews AI fake, in-memory Firestore. The billing guarantee is
 * counted on the fake's call log: an unchanged review is never sent to the
 * AI twice — across re-runs, re-syncs and overlapping invocations.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { LOC_A, SA, mem, resetSync, reviews, runs, seedSub, setScenario } from "@/test/gbp-sync-harness";
import { syncListing } from "@/lib/gbp/sync/run";
import { fakeLogPath } from "./ai/fake";
import { classifyPendingSentiment, sentimentBasis } from "./sentiment";

const ORIGINAL = { ...process.env };

/** Every id the fake AI was asked about, across all calls. */
const billed = (): string[] =>
  ((mem.read(fakeLogPath(SA))?.calls ?? []) as Array<{ ids: string[] }>).flatMap((c) => c.ids);
const byReviewId = () => Object.fromEntries(reviews().map((r) => [r.reviewId as string, r]));
const labelOf = (reviewId: string) => (byReviewId()[reviewId]?.sentiment ?? null) as Record<string, unknown> | null;

function gates(on: { reviewsAi?: boolean; google?: boolean } = {}) {
  const sub = mem.read(`subAccounts/${SA}`)!;
  mem.seed(`subAccounts/${SA}`, { ...sub, reviewsAiEnabledByAgency: on.reviewsAi ?? true, googleEnabledByAgency: on.google ?? true });
}

beforeEach(async () => {
  resetSync();
  process.env.REVIEWS_AI_PROVIDER = "fake";
  process.env.REVIEWS_AI_FAKE_AGENCY_ID = "ag_1";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await syncListing(SA, { trigger: "scheduled" }); // gate off: syncs, classifies nothing
  gates();
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("classifyPendingSentiment", () => {
  it("labels every active review: stars for star-only, the AI for text — one AI item per text review", async () => {
    expect(billed()).toEqual([]); // the gate-off sync sent nothing
    const out = await classifyPendingSentiment(SA);
    expect(out).toMatchObject({ status: "ran", aiConfigured: true, classified: 7, skipped: 0, failed: 0 });
    expect(billed()).toHaveLength(6);
    expect(labelOf("fake-r3")).toMatchObject({ label: "positive", method: "rating", model: null });
    expect(labelOf("fake-r7")).toMatchObject({ label: "positive", method: "ai", model: "fake" });
    expect(labelOf("fake-r6")).toMatchObject({ label: "negative", method: "ai" });
    expect(labelOf("fake-r5")).toMatchObject({ label: "neutral", method: "ai" });
    const r7 = byReviewId()["fake-r7"];
    expect(labelOf("fake-r7")?.basisHash).toBe(sentimentBasis(r7.starRating as number, r7.comment as string));
    // Star-only reviews never reach the AI.
    expect(billed()).not.toContain(byReviewId()["fake-r3"].id);
  });

  it("never re-bills an unchanged review", async () => {
    await classifyPendingSentiment(SA);
    const again = await classifyPendingSentiment(SA);
    expect(again).toMatchObject({ classified: 0, skipped: 0, failed: 0 });
    expect(billed()).toHaveLength(6);
  });

  it("two overlapping runs classify each review once", async () => {
    const [a, b] = await Promise.all([classifyPendingSentiment(SA), classifyPendingSentiment(SA)]);
    expect(billed()).toHaveLength(6);
    expect(new Set(billed()).size).toBe(6);
    expect([a.status, b.status].sort()).toEqual(["ran", "skipped"]);
    expect([a, b].find((o) => o.status === "skipped")?.skipReason).toBe("busy");
  });

  it("caps a run and carries the rest to the next", async () => {
    const first = await classifyPendingSentiment(SA, { max: 3 });
    expect(first).toMatchObject({ classified: 3, skipped: 4 });
    const second = await classifyPendingSentiment(SA, { max: 3 });
    expect(second).toMatchObject({ classified: 3, skipped: 1 });
    await classifyPendingSentiment(SA, { max: 3 });
    expect(billed()).toHaveLength(6);
    expect(reviews().every((r) => r.sentiment)).toBe(true);
  });

  it.each([
    ["the Reviews AI gate is off", { reviewsAi: false }, "gate_off"],
    ["the Google gate is off", { google: false }, "google_gate_off"],
  ])("does nothing when %s", async (_l, on, reason) => {
    gates(on);
    expect(await classifyPendingSentiment(SA)).toMatchObject({ status: "skipped", skipReason: reason, classified: 0 });
    expect(billed()).toEqual([]);
    expect(reviews().some((r) => r.sentiment)).toBe(false);
  });

  it("does nothing without a listing", async () => {
    seedSub(SA, { listing: null });
    gates();
    expect(await classifyPendingSentiment(SA)).toMatchObject({ status: "skipped", skipReason: "no_listing" });
  });

  it("AI not configured: star-only reviews are labelled, text reviews wait — no call", async () => {
    delete process.env.REVIEWS_AI_PROVIDER;
    delete process.env.OPENROUTER_API_KEY;
    const out = await classifyPendingSentiment(SA);
    expect(out).toMatchObject({ status: "ran", aiConfigured: false, classified: 1, skipped: 6, failed: 0 });
    expect(labelOf("fake-r3")).toMatchObject({ method: "rating" });
    expect(labelOf("fake-r7")).toBeNull();
  });

  it("only the inbox's set: tombstoned, other-listing and past-retention reviews are left alone", async () => {
    const docs = reviews();
    const put = (id: string, patch: Record<string, unknown>) =>
      mem.seed(`subAccounts/${SA}/gbpReviews/${id}`, { ...mem.read(`subAccounts/${SA}/gbpReviews/${id}`)!, ...patch });
    const target = (rid: string) => docs.find((d) => d.reviewId === rid)!.id;
    put(target("fake-r7"), { state: "removed" });
    put(target("fake-r6"), { locationName: "locations/other" });
    put(target("fake-r5"), { lastSeenAt: new Date(Date.now() - 31 * 24 * 3600_000) });
    await classifyPendingSentiment(SA);
    expect(billed()).toHaveLength(3);
    for (const rid of ["fake-r7", "fake-r6", "fake-r5"]) expect(labelOf(rid)).toBeNull();
  });
});

describe("through the sync", () => {
  it("every sync that landed pages classifies what is new, and records it on the run", async () => {
    const run = await syncListing(SA, { trigger: "scheduled" });
    expect(run.sentiment).toEqual({ classified: 7, skipped: 0, failed: 0 });
    expect(runs().find((r) => r.runId === run.runId)?.sentiment).toEqual({ classified: 7, skipped: 0, failed: 0 });
    const again = await syncListing(SA, { trigger: "manual", actorUid: "uid_admin" });
    expect(again.sentiment).toEqual({ classified: 0, skipped: 0, failed: 0 });
    expect(billed()).toHaveLength(6); // re-sync: nothing re-billed
  });

  it("an edited review is re-classified — exactly one more AI item", async () => {
    await syncListing(SA, { trigger: "scheduled" });
    setScenario(SA, (s) => {
      const r = s.reviews[LOC_A].reviews.find((x) => x.reviewId === "fake-r1")!;
      r.comment = "Edited: terrible after the update.";
      r.updateTime = "2026-09-01T09:00:00Z";
    });
    await syncListing(SA, { trigger: "scheduled" });
    expect(billed()).toHaveLength(7);
    expect(labelOf("fake-r1")).toMatchObject({ label: "negative", method: "ai" });
  });

  it("a star-only review whose rating changes is relabelled from the stars — no AI call", async () => {
    await syncListing(SA, { trigger: "scheduled" });
    setScenario(SA, (s) => {
      const r = s.reviews[LOC_A].reviews.find((x) => x.reviewId === "fake-r3")!;
      r.starRating = 2;
      r.updateTime = "2026-09-01T09:00:00Z";
    });
    await syncListing(SA, { trigger: "scheduled" });
    expect(labelOf("fake-r3")).toMatchObject({ label: "negative", method: "rating" });
    expect(billed()).toHaveLength(6);
  });

  it("a tombstoned review loses its label (derived from deleted content)", async () => {
    await syncListing(SA, { trigger: "scheduled" });
    expect(labelOf("fake-r4")).not.toBeNull();
    setScenario(SA, (s) => {
      s.reviews[LOC_A].reviews = s.reviews[LOC_A].reviews.filter((r) => r.reviewId !== "fake-r4");
      s.reviews[LOC_A].totalReviewCount = 6;
    });
    await syncListing(SA, { trigger: "scheduled" });
    await syncListing(SA, { trigger: "scheduled" });
    const r4 = byReviewId()["fake-r4"];
    expect(r4.state).toBe("removed");
    expect(r4.sentiment).toBeNull();
  });

  it("a classification failure never changes the sync's result", async () => {
    process.env.REVIEWS_AI_FAKE_AGENCY_ID = "ag_someone_else"; // the fake now refuses this tenant
    const run = await syncListing(SA, { trigger: "scheduled" });
    expect(run.status).toBe("success");
    expect(run.sentiment).toMatchObject({ failed: 6 });
    expect(labelOf("fake-r3")).toMatchObject({ method: "rating" });
  });
});
