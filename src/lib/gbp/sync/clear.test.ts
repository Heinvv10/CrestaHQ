import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * MULTI_LISTING_V1_PLAN.md H3 + H5 — clearing is per listing. Clearing the
 * extra listing drops only its reviews, summary and state doc; the main
 * listing's cache (auto-reply drafts and held-alert bases included), summary
 * and state, and every marker (`autoReplyNever`, `autoReplyDismissed`) stay.
 * Markers are keyed by location, so a listing removed and re-added still
 * remembers the reply it had.
 */

vi.mock("@/lib/firebase/admin", async () => (await import("@/test/gbp-sync-store")).adminMock());

import {
  ACCOUNT,
  LOC_A,
  LOC_NORTH,
  SA,
  mem,
  recordingSleep,
  removeExtraListings,
  resetSync,
  reviewOn,
  reviews,
  seedExtraListing,
  summaryOf,
  syncState,
} from "@/test/gbp-sync-harness";
import { autoReplyDismissedCollection } from "@/lib/reputation/auto-reply/store";
import { decide } from "@/lib/reputation/auto-reply/decide";
import { autoReplyNeverCollection, autoReplyNeverPath, stableReviewKey } from "../auto-reply-never";
import { clearListing } from "../listing-events";
import { locId } from "../listings";
import { clearAllGbpCaches, clearGbpCache } from "./clear";
import { syncSubAccount } from "./sub-account";
import { syncStatePath } from "./types";

const ORIGINAL = { ...process.env };
let clock: ReturnType<typeof recordingSleep>;
const sync = () => syncSubAccount(SA, { trigger: "scheduled", sleep: clock.sleep });
const on = (loc: string) => reviews().filter((r) => r.locationName === loc);
const sub = () => mem.read(`subAccounts/${SA}`)!;
const northSummary = () => (sub().gbpSummaries as Record<string, unknown> | undefined)?.[locId(LOC_NORTH)];
const markers = () => mem.list(autoReplyNeverCollection(SA)).map((m) => m.id).sort();
const dismissed = () => mem.list(autoReplyDismissedCollection(SA)).map((m) => m.id).sort();
const NORTH_REPLIED = reviewOn(LOC_NORTH, "north-replied", 5, 22, "Thanks from the north team.");

/** An auto-reply draft + a held-alert basis on one review doc of `loc`, and a Discard of it. */
function decorate(loc: string) {
  const doc = on(loc).find((r) => !r.reply)!;
  const path = `subAccounts/${SA}/gbpReviews/${doc.id}`;
  mem.seed(path, { ...mem.read(path)!, pendingReply: { text: "draft", reason: "approval" }, heldAlertBasis: "basis-1" });
  mem.seed(`${autoReplyDismissedCollection(SA)}/${stableReviewKey(String(doc.reviewName))}`, { basisHash: "basis-1" });
  return doc.id;
}

beforeEach(() => {
  resetSync();
  clock = recordingSleep();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.restoreAllMocks();
});

describe("single listing: unchanged", () => {
  it.each([
    ["clearGbpCache", () => clearGbpCache(SA)],
    ["clearAllGbpCaches", () => clearAllGbpCaches(SA)],
  ])("%s drops the whole cache, the summary and the state doc — and no marker", async (_n, clear) => {
    await sync();
    decorate(LOC_A);
    const [keptMarkers, keptDismissed] = [markers(), dismissed()];
    expect(keptMarkers).toHaveLength(2); // fake-r7 and fake-r3 carry replies
    await clear();
    expect(reviews()).toHaveLength(0);
    expect(summaryOf()).toBeNull();
    expect(syncState()).toBeUndefined();
    expect(sub()).not.toHaveProperty("gbpSummaries");
    expect(markers()).toEqual(keptMarkers);
    expect(dismissed()).toEqual(keptDismissed);
  });
});

describe("two listings", () => {
  beforeEach(async () => {
    seedExtraListing(SA, LOC_NORTH, [NORTH_REPLIED, reviewOn(LOC_NORTH, "north-1", 4, 8)]);
    await sync();
  });

  it("clearing the extra leaves the main listing's cache, drafts, summary, state and every marker", async () => {
    const mainDoc = decorate(LOC_A);
    decorate(LOC_NORTH);
    const [keptMarkers, keptDismissed, mainSummary] = [markers(), dismissed(), summaryOf()];
    expect(keptMarkers).toHaveLength(3);
    removeExtraListings(SA);
    await clearGbpCache(SA, LOC_NORTH);

    expect(on(LOC_NORTH)).toHaveLength(0);
    expect(mem.read(syncStatePath(SA, LOC_NORTH))).toBeUndefined();
    expect(northSummary()).toBeUndefined();

    expect(on(LOC_A)).toHaveLength(7);
    expect(on(LOC_A).find((r) => r.id === mainDoc)).toMatchObject({
      pendingReply: { text: "draft", reason: "approval" }, heldAlertBasis: "basis-1",
    });
    expect(summaryOf()).toEqual(mainSummary);
    expect(syncState()).toMatchObject({ lease: null });
    expect(markers()).toEqual(keptMarkers);
    expect(dismissed()).toEqual(keptDismissed);
  });

  it("clearing everything (gate off) drops both listings and a failed clear's leftovers — never a marker", async () => {
    mem.seed(`subAccounts/${SA}/private/gbpSyncState_ghost`, { lease: null, pass: null });
    mem.seed(`subAccounts/${SA}/gbpReviews/ghost`, { locationName: "locations/ghost", state: "active" });
    const keptMarkers = markers();
    await clearAllGbpCaches(SA);
    expect(reviews()).toHaveLength(0);
    expect(syncState()).toBeUndefined();
    expect(mem.all().filter((d) => /gbpSyncState_/.test(d.path))).toEqual([]);
    expect(summaryOf()).toBeNull();
    expect(sub()).not.toHaveProperty("gbpSummaries");
    expect(markers()).toEqual(keptMarkers);
    expect(mem.read(`subAccounts/${SA}/private/googleConnection`)).toBeDefined();
  });

  it("clearing the listings (disconnect / admin clear) drops the extras the doc no longer names", async () => {
    await clearListing(SA, "uid_admin", "admin_cleared");
    expect(sub()).toMatchObject({ googleListing: null, googleExtraListings: [] });
    expect(reviews()).toHaveLength(0);
    expect(mem.all().filter((d) => /gbpSyncState/.test(d.path))).toEqual([]);
    expect(sub()).not.toHaveProperty("gbpSummaries");
  });

  it("H5: a listing removed and re-added still remembers its reply — the marker survives and the engine skips `never`", async () => {
    const name = `${ACCOUNT}/${LOC_NORTH}/reviews/north-replied`;
    const marker = mem.read(autoReplyNeverPath(SA, name));
    expect(marker).toMatchObject({ reason: "replied" });
    // The same review id on the main listing is a different key: no collision.
    expect(stableReviewKey(name)).not.toBe(stableReviewKey(`${ACCOUNT}/${LOC_A}/reviews/north-replied`));

    removeExtraListings(SA);
    await clearGbpCache(SA, LOC_NORTH);
    // Meanwhile the reply is deleted at Google; then the listing comes back.
    seedExtraListing(SA, LOC_NORTH, [{ ...NORTH_REPLIED, reply: null }, reviewOn(LOC_NORTH, "north-1", 4, 8)]);
    await sync();

    const back = on(LOC_NORTH).find((r) => r.reviewId === "north-replied")!;
    expect(back).toMatchObject({ state: "active", reply: null });
    expect(mem.read(autoReplyNeverPath(SA, String(back.reviewName)))).toEqual(marker);
    const never = mem.read(`${autoReplyNeverCollection(SA)}/${stableReviewKey(String(back.reviewName))}`) !== undefined;
    const now = Date.now();
    const verdict = decide(
      {
        state: "active", locationName: LOC_NORTH, starRating: 5, comment: null, createTimeMs: now, lastSeenAtMs: now,
        hasReply: false, hadReply: back.hadReply === true, never, inFlight: false, autoReplied: false, basisHash: "b",
        pending: null, dismissedBasisHash: null,
      },
      {
        enabled: true, modes: { 1: "approval", 2: "approval", 3: "approval", 4: "auto", 5: "auto" }, includeBacklog: true,
        enabledAtMs: 0, listingLocationName: LOC_NORTH,
      },
      { now, runStartedAt: now - 1000 },
      { postsToday: 0, autoDraftsToday: 0 },
    );
    expect(verdict).toEqual({ verdict: "skip", why: "never" });
  });
});
