import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/sub-accounts/[id]/reputation/overview — the route over REAL
 * require-tenancy, the real sync (fake provider, fenced) and the in-memory
 * Firestore: numbers computed from the fake's 7 synced reviews and seeded
 * reviewRequests rows. The clock is frozen: the fixture reviews are dated
 * August 2026 and a real clock would walk them out of the range.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { AGENCY, LEAK_MARKERS, OTHER_SA, SA, asUser, mem, resetSync, seedSub } from "@/test/gbp-sync-harness";
import { syncListing } from "@/lib/gbp/sync/run";
import { classifyPendingSentiment } from "@/lib/reputation/sentiment";
import { GET } from "./route";

const ORIGINAL = { ...process.env };
const NOW = new Date("2026-09-14T10:00:00Z");
const DAY = 24 * 3600_000;

type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function read(uid = "uid_collab", query = "", sa = SA): Promise<{ status: number; body: Body }> {
  const res = await GET(asUser(`http://127.0.0.1:3100/api/sub-accounts/${sa}/reputation/overview${query}`, uid), {
    params: Promise.resolve({ id: sa }),
  });
  const text = await res.text();
  expect(text).not.toMatch(LEAK_MARKERS);
  // Aggregates only — never review text, reviewer names or contact ids.
  expect(text).not.toMatch(/Fixture review|Fixture Reviewer|c_req/);
  return { status: res.status, body: JSON.parse(text) as Body };
}

function seedRequest(sa: string, id: string, daysAgo: number, channel = "sms") {
  mem.seed(`subAccounts/${sa}/reviewRequests/${id}`, {
    agencyId: AGENCY, subAccountId: sa, createdByUid: "review-request", contactId: `c_req_${id}`, channel,
    trigger: "manual", status: "sent", messageSid: null, sentAt: new Date(NOW.getTime() - daysAgo * DAY),
    clickedAt: null, feedbackAt: null,
  });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  resetSync();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await syncListing(SA, { trigger: "scheduled" });
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("authorization", () => {
  it.each([
    ["a signed-in non-member", "uid_stranger"],
    ["an admin of ANOTHER sub-account", "uid_other_admin"],
  ])("refuses %s", async (_l, uid) => {
    expect((await read(uid)).status).toBe(403);
  });

  it("refuses a range that is not a preset", async () => {
    const { status, body } = await read("uid_collab", "?range=7d");
    expect(status).toBe(400);
    expect(body).toMatchObject({ code: "invalid_filter", field: "range" });
  });
});

describe("numbers over the synced fixture reviews", () => {
  it("default 90d: count, average, distribution, coverage, reply time, listing and health", async () => {
    const { status, body } = await read();
    expect(status).toBe(200);
    expect(body.reviewsUnavailable).toBeNull();
    expect(body.range).toMatchObject({ preset: "90d", bucket: "week" });
    expect(body.listing).toEqual({ averageRating: 3.6, totalReviewCount: 7 });
    expect(body.health).toBe("ok");
    expect(body.reviews.count).toBe(7);
    expect(body.reviews.avgRating).toBeCloseTo(25 / 7);
    expect(body.reviews.distribution).toEqual({ 1: 1, 2: 1, 3: 1, 4: 1, 5: 3 });
    expect(body.reviews.response).toEqual({
      replied: 2, unreplied: 5, coverage: 2 / 7, replyHours: { avg: 3, median: 3, counted: 2, excluded: 0 },
    });
    expect(body.truncated).toEqual({ reviews: false, requests: false });
  });

  it("30d: the range and the range before it", async () => {
    const { body } = await read("uid_collab", "?range=30d");
    // 27th, 24th, 21st, 18th in range; 15th, 12th, 9th in the 30 days before.
    expect(body.reviews.count).toBe(4);
    expect(body.reviews.avgRating).toBeCloseTo(15 / 4);
    expect(body.reviews.previous.count).toBe(3);
    expect(body.reviews.previous.avgRating).toBeCloseTo(10 / 3);
  });

  it("leaves out tombstoned, other-listing and past-retention reviews — the inbox's set", async () => {
    const docs = mem.list(`subAccounts/${SA}/gbpReviews`).sort((a, b) => String(a.reviewId).localeCompare(String(b.reviewId)));
    const put = (id: string, patch: Record<string, unknown>) =>
      mem.seed(`subAccounts/${SA}/gbpReviews/${id}`, { ...mem.read(`subAccounts/${SA}/gbpReviews/${id}`)!, ...patch });
    put(docs[0].id, { state: "removed", starRating: null }); // fake-r1 (5★)
    put(docs[1].id, { lastSeenAt: new Date(NOW.getTime() - 31 * DAY) }); // fake-r2 (1★)
    put(docs[2].id, { locationName: "locations/some-other" }); // fake-r3 (4★, replied)
    const { body } = await read();
    expect(body.reviews.count).toBe(4);
    expect(body.reviews.distribution).toEqual({ 1: 0, 2: 1, 3: 1, 4: 0, 5: 2 });
    expect(body.reviews.response.replied).toBe(1);
  });
});

describe("requests", () => {
  it("counts this sub-account's log only, by channel, with counting-since", async () => {
    seedRequest(SA, "a", 1);
    seedRequest(SA, "b", 3, "whatsapp_template");
    seedRequest(SA, "c", 100);
    seedRequest(OTHER_SA, "x", 1);
    seedRequest(OTHER_SA, "y", 2);
    const { body } = await read();
    expect(body.requests).toEqual({
      sent: 2,
      byChannel: { sms: 1, whatsapp_template: 1 },
      previous: null,
      countingSince: new Date(NOW.getTime() - 100 * DAY).toISOString(),
    });
    expect(body.trend.reduce((n: number, b: Body) => n + b.requests, 0)).toBe(2);
  });
});

describe("review data unavailable — requests still shown", () => {
  beforeEach(() => seedRequest(SA, "a", 1));

  it.each([
    ["gate_off", { gateOn: false }],
    ["not_connected", { connected: false }],
    ["no_listing", { listing: null }],
  ] as const)("%s → reviews null", async (reason, opts) => {
    seedSub(SA, opts);
    const { status, body } = await read();
    expect(status).toBe(200);
    expect(body.reviewsUnavailable).toBe(reason);
    expect(body).toMatchObject({ reviews: null, listing: null, health: null });
    expect(body.requests.sent).toBe(1);
    expect(body.trend.every((b: Body) => b.reviews === null)).toBe(true);
  });

  it("a flagged connection still serves the cached reviews, with health reconnect_required", async () => {
    seedSub(SA, { reconnectRequired: true });
    const { body } = await read();
    expect(body.reviewsUnavailable).toBeNull();
    expect(body.health).toBe("reconnect_required");
    expect(body.reviews.count).toBe(7);
  });
});

describe("checklist — from real state only", () => {
  it("all false on a bare sub-account", async () => {
    seedSub(SA, { connected: false, listing: null });
    expect((await read()).body.checklist).toEqual({
      googleConnected: false, listingSelected: false, reviewLinkConfigured: false, widgetExists: false, requestLogged: false,
    });
  });

  it("each item turns on from the doc it reads", async () => {
    seedRequest(SA, "a", 1);
    const sub = mem.read(`subAccounts/${SA}`)!;
    mem.seed(`subAccounts/${SA}`, {
      ...sub,
      googleReviewConfig: { reviewUrl: "https://g.page/r/fixture/review" },
      gbpWidgetMeta: { publicId: "p".repeat(32), enabled: true, allowedOrigins: [], maxReviews: 12, updatedAt: NOW },
    });
    expect((await read()).body.checklist).toEqual({
      googleConnected: true, listingSelected: true, reviewLinkConfigured: true, widgetExists: true, requestLogged: true,
    });
  });

  it("a revoked connection is not 'connected'", async () => {
    seedSub(SA, { reconnectRequired: true });
    expect((await read()).body.checklist.googleConnected).toBe(false);
  });
});

describe("sentiment (SP5 b)", () => {
  it("counts the cached labels over the reviews in range, and says whether Reviews AI is on and configured", async () => {
    process.env.REVIEWS_AI_PROVIDER = "fake";
    process.env.REVIEWS_AI_FAKE_AGENCY_ID = "ag_1";
    expect((await read()).body.reviewsAi).toEqual({ enabled: false, configured: true });
    mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, reviewsAiEnabledByAgency: true });
    const before = await read();
    expect(before.body.reviews.sentiment).toEqual({ positive: 0, neutral: 0, negative: 0, notAnalysed: 7 });
    await classifyPendingSentiment(SA);
    const { body } = await read();
    expect(body.reviewsAi).toEqual({ enabled: true, configured: true });
    // fake rule: r7 r4 positive (text), r3 positive (4★ star-only), r6 r2 negative, r5 r1 neutral
    expect(body.reviews.sentiment).toEqual({ positive: 3, neutral: 2, negative: 2, notAnalysed: 0 });
  });

  it("not configured: an OpenRouter deployment without a key", async () => {
    delete process.env.REVIEWS_AI_PROVIDER;
    delete process.env.OPENROUTER_API_KEY;
    expect((await read()).body.reviewsAi).toEqual({ enabled: false, configured: false });
  });
});
