import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PR 4 alerts, driven through the real writers on the in-memory store: the
 * engine (held), the sync (an auto-replied review edited down to ≤3★), the
 * token flag (reconnect required) and the listing writers (auto-reply
 * switched off). Each alert is one doc in `reviewAutoReplyAlerts`; in fake
 * mode (this harness) nothing is delivered, so the doc is the whole proof.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import { ACCOUNT, AGENCY, LOC_A, LOC_NORTH, SA, asUser, mem } from "@/test/gbp-sync-harness";
import { A1, neverPath, patchSettings, pendingOf, putFixtureReview, resetAutoReply, reviewDoc, sync, syncAndRun } from "@/test/auto-reply-harness";
import { reviewBasis } from "@/lib/reputation/sentiment-basis";
import { sentimentUsagePath } from "@/lib/reputation/sentiment-calls";
import { autoReplyAfterSync } from "./run";
import { textHashOf } from "./store";
import { clearGbpCache } from "@/lib/gbp/sync/clear";
import { markReconnectRequiredIf } from "@/lib/gbp/tokens";
import { clearListing } from "@/lib/gbp/listing-events";
import { PUT } from "@/app/api/sub-accounts/[id]/google/listing/route";
import { POST as POST_REPLY } from "@/app/api/sub-accounts/[id]/gbp/reviews/[reviewDocId]/reply/route";
import { PUT as PUT_SETTINGS } from "@/app/api/sub-accounts/[id]/reputation/auto-reply/route";
import { KEY, callReply } from "@/test/gbp-reply-harness";
import { autoReplyAlertsCollection } from "./alerts";

const ORIGINAL = { ...process.env };
const BASE = `http://127.0.0.1:3100/api/sub-accounts/${SA}`;
const params = { params: Promise.resolve({ id: SA }) };
const alerts = (kind?: string) => mem.list(autoReplyAlertsCollection(SA)).filter((a) => !kind || a.kind === kind);
const select = (locationName: string) =>
  PUT(asUser(`${BASE}/google/listing`, "uid_admin", "PUT", JSON.stringify({ accountName: ACCOUNT, locationName })), params);
const LONG = "The installer arrived late, left cable everywhere and the router still drops every evening around eight o'clock.";

beforeEach(() => {
  resetAutoReply();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("held", () => {
  it("a run that newly holds a review → one alert with the count and no review content", async () => {
    putFixtureReview("fake-h1", 3, LONG, 29, "Private Person");
    await syncAndRun();
    const held = alerts("held");
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ agencyId: AGENCY, subAccountId: SA, createdByUid: "system", count: 1 });
    expect(JSON.stringify(held[0])).not.toMatch(/installer|Private Person/);
  });

  it("the same held review on the next run → no second alert", async () => {
    putFixtureReview("fake-h1", 3, LONG, 29);
    await syncAndRun();
    await syncAndRun();
    expect(alerts("held")).toHaveLength(1);
  });

  it("waiting on a daily limit (the shared 100 drafts/day spent → no_budget) is not a person's job → no alert", async () => {
    const day = new Date().toISOString().slice(0, 10);
    mem.seed(sentimentUsagePath(SA), { day, calls: 100, draftsDay: day, draftCalls: 100, autoDraftCalls: 0 });
    await syncAndRun();
    expect(pendingOf("fake-a1")).toMatchObject({ reason: "no_budget" });
    expect(pendingOf("fake-a2")).toMatchObject({ reason: "no_budget" });
    await syncAndRun();
    expect(alerts("held")).toEqual([]);
  });

  /** fake-a1 carries a fresh queued draft, as if a run drafted it and stopped before posting. */
  async function queueA1() {
    const run = await sync();
    const text = "Thank you for the five stars!";
    mem.seed(`subAccounts/${SA}/gbpReviews/${A1}`, {
      ...reviewDoc("fake-a1"),
      pendingReply: {
        text, textHash: textHashOf(text), basisHash: reviewBasis(reviewDoc("fake-a1")), reason: "auto_queued", model: "fake", at: new Date(),
      },
    });
    return { run, text };
  }

  it("a queued draft moved to approval (auto-reply switched off and on, backlog off) → one alert, not again next run", async () => {
    const { run, text } = await queueA1();
    patchSettings({ enabledAt: new Date("2026-08-30T00:00:00Z") });
    await autoReplyAfterSync(SA, run.startedAt, Date.now() + 240_000);
    expect(pendingOf("fake-a1")).toMatchObject({ reason: "approval", text });
    expect(alerts("held")).toHaveLength(1);
    await syncAndRun();
    expect(alerts("held")).toHaveLength(1);
  });

  it("a queued draft whose star the admin switched to Approval → one alert", async () => {
    const { run, text } = await queueA1();
    patchSettings({ modes: { 1: "approval", 2: "approval", 3: "approval", 4: "auto", 5: "approval" } });
    await autoReplyAfterSync(SA, run.startedAt, Date.now() + 240_000);
    expect(pendingOf("fake-a1")).toMatchObject({ reason: "approval", text });
    expect(alerts("held")).toHaveLength(1);
    expect(alerts("held")[0].count).toBe(1);
  });

  it("a run that holds nothing (only auto-posts) → no alert", async () => {
    const run = await syncAndRun();
    expect(run?.posted).toBeGreaterThan(0);
    expect(alerts("held")).toEqual([]);
  });
});

describe("edited_low", () => {
  it("an auto-replied 5★ edited to 2★ → one alert: star + first 80 characters only", async () => {
    await syncAndRun();
    expect(reviewDoc("fake-a1").autoReplied).toBeTruthy();
    putFixtureReview("fake-a1", 2, LONG, 28, "Private Person");
    await sync();
    const edited = alerts("edited_low");
    expect(edited).toHaveLength(1);
    expect(edited[0]).toMatchObject({ subAccountId: SA, star: 2 });
    expect(JSON.stringify(edited[0])).not.toMatch(/installer|Private Person/);
  });

  it("further edits, resyncs and a cache clear → still one alert", async () => {
    await syncAndRun();
    putFixtureReview("fake-a1", 2, LONG, 28);
    await sync();
    putFixtureReview("fake-a1", 1, `${LONG} Worse.`, 28);
    await sync();
    await sync();
    await clearGbpCache(SA);
    await sync();
    expect(alerts("edited_low")).toHaveLength(1);
  });

  it("an auto-replied 5★ edited to 4★ → no alert", async () => {
    await syncAndRun();
    putFixtureReview("fake-a1", 4, null, 28);
    await sync();
    expect(alerts("edited_low")).toEqual([]);
  });

  it("an auto-replied 5★ edited to exactly 3★ → one alert", async () => {
    await syncAndRun();
    putFixtureReview("fake-a1", 3, null, 28);
    await sync();
    expect(alerts("edited_low")).toMatchObject([{ star: 3 }]);
  });

  it("an auto-replied 3★ that gains text (star unchanged) → one alert; one that stays blank → none", async () => {
    patchSettings({ modes: { 1: "approval", 2: "approval", 3: "auto", 4: "auto", 5: "auto" } });
    putFixtureReview("fake-t3", 3, null, 29);
    putFixtureReview("fake-t4", 3, null, 27);
    await syncAndRun();
    expect(reviewDoc("fake-t3").autoReplied).toBeTruthy();
    expect(reviewDoc("fake-t4").autoReplied).toBeTruthy();
    await sync();
    expect(alerts("edited_low")).toEqual([]);
    putFixtureReview("fake-t3", 3, "Added some words", 29);
    await sync();
    expect(alerts("edited_low")).toMatchObject([{ star: 3 }]);
  });

  it("after a cache clear (Google gate toggled): an auto-replied review edited to 2★ still alerts once", async () => {
    await syncAndRun();
    await clearGbpCache(SA);
    await sync();
    expect(mem.read(neverPath("fake-a1"))).toMatchObject({ reason: "auto_replied", star: 5 });
    expect(alerts("edited_low")).toEqual([]);
    putFixtureReview("fake-a1", 2, null, 28);
    await sync();
    expect(alerts("edited_low")).toMatchObject([{ star: 2 }]);
  });

  it("an edit that stays above 3★, or a review that was never auto-replied → no alert", async () => {
    putFixtureReview("fake-h1", 5, "Great", 29);
    patchSettings({ modes: { 1: "approval", 2: "approval", 3: "approval", 4: "auto", 5: "approval" } });
    await syncAndRun();
    putFixtureReview("fake-a2", 4, "Still fine", 26);
    putFixtureReview("fake-h1", 1, "Changed my mind", 29);
    await sync();
    expect(alerts("edited_low")).toEqual([]);
  });

  it("a sync that rewrote the marker's reason (overlapping the post) keeps its star → still detected after a clear", async () => {
    await syncAndRun();
    mem.seed(neverPath("fake-a1"), { ...mem.read(neverPath("fake-a1")), reason: "replied" });
    await clearGbpCache(SA);
    await sync();
    putFixtureReview("fake-a1", 2, null, 28);
    await sync();
    expect(alerts("edited_low")).toHaveLength(1);
  });

  it("a person's reply replaced the auto reply → no longer auto-replied: an edit to 2★ does not alert", async () => {
    await syncAndRun();
    const res = await callReply(POST_REPLY, "POST", "uid_admin", SA, A1, { comment: "Thanks — from a person", idempotencyKey: KEY });
    expect(res.status).toBe(200);
    expect(reviewDoc("fake-a1").autoReplied).toBeNull();
    expect(mem.read(neverPath("fake-a1"))).not.toHaveProperty("star");
    putFixtureReview("fake-a1", 2, null, 28);
    await sync();
    await clearGbpCache(SA);
    await sync();
    expect(alerts("edited_low")).toEqual([]);
  });
});

describe("reconnect_required", () => {
  const expected = { refreshToken: `fake-refresh:${SA}:900` };

  it("false→true → one alert; flagging again while still flagged → none", async () => {
    await markReconnectRequiredIf(SA, "revoked", expected);
    await markReconnectRequiredIf(SA, "revoked", expected);
    expect(alerts("reconnect_required")).toHaveLength(1);
    expect(alerts("reconnect_required")[0]).toMatchObject({ agencyId: AGENCY, subAccountId: SA });
  });

  it("after a reconnect clears it, the next flip alerts again", async () => {
    await markReconnectRequiredIf(SA, "revoked", expected);
    const sub = mem.read(`subAccounts/${SA}`)!;
    mem.seed(`subAccounts/${SA}`, { ...sub, googleConnectionMeta: { ...(sub.googleConnectionMeta as object), reconnectRequired: false } });
    await markReconnectRequiredIf(SA, "insufficient_scope", expected);
    expect(alerts("reconnect_required")).toHaveLength(2);
  });

  it("auto-reply off for this sub-account → the flag is set, no alert", async () => {
    patchSettings({ enabled: false });
    await markReconnectRequiredIf(SA, "revoked", expected);
    expect(mem.read(`subAccounts/${SA}`)!.googleConnectionMeta).toMatchObject({ reconnectRequired: true });
    expect(alerts("reconnect_required")).toEqual([]);
  });

  it("switching auto-reply ON while Google needs reconnecting is refused; editing it while on is not", async () => {
    const body = (enabled: boolean) => JSON.stringify({ enabled, modes: { 1: "approval", 2: "approval", 3: "approval", 4: "auto", 5: "auto" }, includeBacklog: false });
    const put = (enabled: boolean) => PUT_SETTINGS(asUser(`${BASE}/reputation/auto-reply`, "uid_admin", "PUT", body(enabled)), params);
    await markReconnectRequiredIf(SA, "revoked", expected);
    expect((await put(true)).status).toBe(200);
    expect((await put(false)).status).toBe(200);
    const refused = await put(true);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "reconnect_required" });
  });

  it("a newer grant (secret changed) is not flagged → no alert", async () => {
    await markReconnectRequiredIf(SA, "revoked", { refreshToken: "some-older-token" });
    expect(alerts("reconnect_required")).toEqual([]);
  });
});

describe("listing_changed", () => {
  it("another listing while auto-reply is on → one alert", async () => {
    expect((await select(LOC_NORTH)).status).toBe(200);
    expect(alerts("listing_changed")).toHaveLength(1);
    expect((await select(LOC_A)).status).toBe(200);
    expect(alerts("listing_changed")).toHaveLength(1);
  });

  it("another listing while auto-reply is already off → no alert", async () => {
    patchSettings({ enabled: false });
    expect((await select(LOC_NORTH)).status).toBe(200);
    expect(alerts("listing_changed")).toEqual([]);
  });

  it("re-selecting the same listing → no alert", async () => {
    expect((await select(LOC_A)).status).toBe(200);
    expect(alerts("listing_changed")).toEqual([]);
  });

  it("a clear (disconnect) while on → one alert; while already off → none", async () => {
    await clearListing(SA, "uid_admin", "disconnected");
    expect(alerts("listing_changed")).toHaveLength(1);
    const sub = mem.read(`subAccounts/${SA}`)!;
    mem.seed(`subAccounts/${SA}`, { ...sub, googleListing: { accountName: ACCOUNT, locationName: LOC_A } });
    await clearListing(SA, "uid_admin", "admin_cleared");
    expect(alerts("listing_changed")).toHaveLength(1);
  });
});
