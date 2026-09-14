import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SP5 (b): sentiment labels are for the tenant's own dashboard. The public
 * feed is an allow-list serializer — a classified review must not carry its
 * label (or anything derived from it) onto a customer's website.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { SA, mem, resetSync, reviews } from "@/test/gbp-sync-harness";
import { createWidget, feed, freshIp } from "@/test/gbp-feed-harness";
import { syncListing } from "@/lib/gbp/sync/run";

const ORIGINAL = { ...process.env };

beforeEach(async () => {
  resetSync();
  process.env.REVIEWS_AI_PROVIDER = "fake";
  process.env.REVIEWS_AI_FAKE_AGENCY_ID = "ag_1";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, reviewsAiEnabledByAgency: true });
  await syncListing(SA, { trigger: "scheduled" });
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("the public feed never carries sentiment", () => {
  it("serves classified reviews without the label, method, basis or model", async () => {
    expect(reviews().every((r) => r.sentiment)).toBe(true); // the premise: every review is labelled
    const id = await createWidget();
    const text = await (await feed(id, { "x-forwarded-for": freshIp() })).text();
    const body = JSON.parse(text) as { reviews: Array<Record<string, unknown>> };
    expect(body.reviews).toHaveLength(7);
    expect(text).not.toMatch(/sentiment|basisHash|"method"|"(positive|neutral|negative)"|"fake"/);
    for (const r of body.reviews) expect(Object.keys(r)).not.toContain("sentiment");
  });
});
