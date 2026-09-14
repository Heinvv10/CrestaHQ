import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST …/gbp/reviews/[reviewDocId]/draft — an AI reply DRAFT for an admin to
 * edit. Real route, tenancy, gates, review lookup, daily cap and the fenced
 * Reviews AI fake; Firestore in memory. The hard rule: drafting posts NOTHING
 * — every test ends with zero putReply / deleteReply calls — and stores no
 * draft text anywhere.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());
const override = vi.hoisted(() => ({ ai: null as null | Record<string, unknown> }));
vi.mock("@/lib/reputation/ai/select", async (orig) => {
  const real = await orig<typeof import("@/lib/reputation/ai/select")>();
  return { ...real, getReviewsAiFor: async (sa: string) => (override.ai as never) ?? real.getReviewsAiFor(sa) };
});

import { AGENCY, OTHER_SA, SA, mem, resetSync } from "@/test/gbp-sync-harness";
import { calls, callReply, docIdOf, reviewPath } from "@/test/gbp-reply-harness";
import { syncListing } from "@/lib/gbp/sync/run";
import { fakeLogPath } from "@/lib/reputation/ai/fake";
import { DAILY_AI_CALL_CAP, sentimentUsagePath } from "@/lib/reputation/sentiment-calls";
import { resetDraftLimiter } from "@/lib/reputation/draft";
import { POST } from "./route";

const ORIGINAL = { ...process.env };
const R6 = docIdOf("fake-r6"); // 2 stars, "Fixture review: technician arrived late."
const GUIDE = "Sign off as The Fixture Team.";
const draft = (uid = "uid_admin", docId = R6, sa = SA) => callReply(POST as never, "POST", uid, sa, docId);
const today = () => new Date().toISOString().slice(0, 10);
const drafts = (sa = SA) => (mem.read(fakeLogPath(sa))?.drafts ?? []) as unknown[];
const patchSub = (patch: Record<string, unknown>, sa = SA) => mem.seed(`subAccounts/${sa}`, { ...mem.read(`subAccounts/${sa}`)!, ...patch });

beforeEach(async () => {
  resetSync();
  resetDraftLimiter();
  override.ai = null;
  process.env.REVIEWS_AI_PROVIDER = "fake";
  process.env.REVIEWS_AI_FAKE_AGENCY_ID = AGENCY;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await syncListing(SA, { trigger: "scheduled" });
  patchSub({ reviewsAiEnabledByAgency: true, reviewsAiConfig: { replyGuidelines: GUIDE, updatedAt: new Date(), updatedByUid: "uid_admin" } });
});
afterEach(() => {
  // The hard rule, after every test: nothing reached Google's reply API.
  expect(calls(SA)).toEqual([]);
  expect(calls(OTHER_SA)).toEqual([]);
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("a draft", () => {
  it("an admin gets a draft built from the review, the listing and the guidelines", async () => {
    const { status, body } = await draft();
    expect(status).toBe(200);
    expect(body.draft).toBe(`Hi Fixture, thank you for your 2-star review of Velo Test Fibre — Gqeberha.\n${GUIDE}`);
    expect(drafts()).toHaveLength(1);
    expect(mem.read(sentimentUsagePath(SA))).toMatchObject({ day: today(), calls: 1 });
  });

  it("stores no draft text: the review and sub-account docs are unchanged, the fake log holds no text", async () => {
    const review = JSON.stringify(mem.read(reviewPath("fake-r6")));
    const sub = JSON.stringify(mem.read(`subAccounts/${SA}`));
    const { body } = await draft();
    expect(JSON.stringify(mem.read(reviewPath("fake-r6")))).toBe(review);
    expect(JSON.stringify(mem.read(`subAccounts/${SA}`))).toBe(sub);
    expect(JSON.stringify(mem.read(fakeLogPath(SA)))).not.toContain(String(body.draft).slice(0, 20));
    const logged = JSON.stringify([...(console.warn as never as { mock: { calls: unknown[] } }).mock.calls, ...(console.error as never as { mock: { calls: unknown[] } }).mock.calls]);
    expect(logged).not.toMatch(/technician|thank you for your/i);
  });

  it("counts against the SAME daily AI cap as sentiment, and stops at it without calling the AI", async () => {
    mem.seed(sentimentUsagePath(SA), { day: today(), calls: DAILY_AI_CALL_CAP - 1 });
    expect((await draft()).status).toBe(200);
    const capped = await draft();
    expect(capped.status).toBe(429);
    expect(capped.body.code).toBe("daily_cap");
    expect(drafts()).toHaveLength(1);
    expect(mem.read(sentimentUsagePath(SA))).toMatchObject({ calls: DAILY_AI_CALL_CAP });
  });

  it("a usage doc from an earlier day starts today's count again", async () => {
    mem.seed(sentimentUsagePath(SA), { day: "2020-01-01", calls: DAILY_AI_CALL_CAP });
    expect((await draft()).status).toBe(200);
    expect(mem.read(sentimentUsagePath(SA))).toMatchObject({ day: today(), calls: 1 });
  });

  it("an AI failure is a 424 draft_failed — no text, nothing posted", async () => {
    override.ai = { model: "x", classifySentiment: vi.fn(), draftReply: vi.fn(async () => ({ text: null, failure: "model" })) };
    const { status, body } = await draft();
    expect(status).toBe(424);
    expect(body.code).toBe("draft_failed");
    expect(body.draft).toBeUndefined();
  });
});

describe("who and what", () => {
  it.each([
    ["a collaborator", "uid_collab"],
    ["a signed-in non-member", "uid_stranger"],
    ["an admin of another sub-account", "uid_other_admin"],
  ])("refuses %s (403), drafting nothing", async (_l, uid) => {
    expect((await draft(uid)).status).toBe(403);
    expect(drafts()).toHaveLength(0);
  });

  it.each([
    ["Google gate off", { googleEnabledByAgency: false }, 403, "gate_off"],
    ["Reviews AI gate off", { reviewsAiEnabledByAgency: false }, 403, "ai_gate_off"],
    ["Reviews AI gate unset", { reviewsAiEnabledByAgency: undefined }, 403, "ai_gate_off"],
  ])("%s → %i %s", async (_l, patch, status, code) => {
    patchSub(patch);
    const res = await draft();
    expect([res.status, res.body.code]).toEqual([status, code]);
    expect(drafts()).toHaveLength(0);
  });

  it.each([
    ["a malformed id", "not-a-doc-id"],
    ["an unknown id", "f".repeat(40)],
    ["a removed (tombstoned) review — while OTHER_SA's review with the same id is active", "TOMBSTONE"],
  ])("404s %s", async (_l, id) => {
    await syncListing(OTHER_SA, { trigger: "scheduled" });
    if (id === "TOMBSTONE") mem.seed(reviewPath("fake-r6"), { ...mem.read(reviewPath("fake-r6"))!, state: "removed" });
    const res = await draft("uid_admin", id === "TOMBSTONE" ? R6 : id);
    expect(res.status).toBe(404);
    expect(drafts()).toHaveLength(0);
  });

  it("503 ai_not_configured when the deployment has no Reviews AI", async () => {
    delete process.env.REVIEWS_AI_PROVIDER;
    delete process.env.OPENROUTER_API_KEY;
    const res = await draft();
    expect([res.status, res.body.code]).toEqual([503, "ai_not_configured"]);
  });

  it("503 ai_not_configured when the fake is refused for this sub-account (outside the fixture agency)", async () => {
    process.env.REVIEWS_AI_FAKE_AGENCY_ID = "ag_elsewhere";
    const res = await draft();
    expect([res.status, res.body.code]).toEqual([503, "ai_not_configured"]);
    expect(mem.read(sentimentUsagePath(SA))).toBeUndefined();
  });

  it("limits each user to 10 drafts a minute (429 rate_limited), per user", async () => {
    for (let i = 0; i < 10; i++) expect((await draft()).status).toBe(200);
    const limited = await draft();
    expect([limited.status, limited.body.code]).toEqual([429, "rate_limited"]);
    expect(drafts()).toHaveLength(10);
    mem.seed(`subAccounts/${SA}/subAccountMembers/uid_admin2`, { status: "active", role: "admin", subAccountRole: "admin" });
    const { claims } = await import("@/test/gbp-sync-harness");
    claims.set("uid_admin2", { status: "active", agencyId: AGENCY, agencyRole: null });
    expect((await draft("uid_admin2")).status).toBe(200);
  });

  it("drafts without guidelines when none are saved", async () => {
    patchSub({ reviewsAiConfig: null });
    expect((await draft()).body.draft).toBe("Hi Fixture, thank you for your 2-star review of Velo Test Fibre — Gqeberha.");
  });

  it("an anonymous reviewer gets no name", async () => {
    const anon = docIdOf("fake-r4");
    expect(String((await draft("uid_admin", anon)).body.draft)).toMatch(/^Thank you for your 5-star review/);
  });
});
