import { createHash } from "node:crypto";
import type { GbpReview } from "@/lib/gbp/provider/types";
import { fakeLogPath } from "@/lib/reputation/ai/fake";
import { syncListing } from "@/lib/gbp/sync/run";
import { autoReplyAfterSync } from "@/lib/reputation/auto-reply/run";
import { AGENCY, ACCOUNT, LOC_A, LOC_NORTH, OTHER_SA, SA, mem, resetSync, setScenario } from "@/test/gbp-sync-harness";
import { calls, docIdOf, reviewPath } from "@/test/gbp-reply-harness";

/**
 * Seam harness for the review auto-reply engine, on top of gbp-sync-harness:
 * the in-memory Firestore, PR 1's REAL fake GBP provider behind the real
 * fence (every putReply is logged in its scenario), and the REAL fenced
 * Reviews AI fake (every draft logged in `reviewsAiFakeLog.drafts`). Nothing
 * between the engine and Firestore is mocked; a test file may wrap the AI's
 * `draftReply` to act DURING the call.
 *
 * Fixture (enabledAt 2026-08-25, backlog off, default modes 1-3★ approval,
 * 4-5★ auto) — eligible after a sync:
 *   fake-a1  5★ no comment      (28 Aug)  → auto
 *   fake-a2  4★ whitespace only (26 Aug)  → auto (rating-only)
 *   fake-r7  5★ texted, replied (27 Aug)  → skip (replied)
 * Everything older is before enabledAt unless a test turns backlog on.
 */

export const ENABLED_AT = new Date("2026-08-25T00:00:00Z");
export const A1 = docIdOf("fake-a1");
export const A2 = docIdOf("fake-a2");

function fixtureReview(id: string, starRating: GbpReview["starRating"], comment: string | null, day: number, name = `Fixture Reviewer ${id}`): GbpReview {
  const time = `2026-08-${String(day).padStart(2, "0")}T09:00:00Z`;
  return {
    name: `${ACCOUNT}/${LOC_A}/reviews/${id}`, reviewId: id,
    reviewer: { displayName: name, profilePhotoUrl: null, isAnonymous: false },
    starRating, comment, createTime: time, updateTime: time, reply: null,
  };
}

/** Add (or replace) a review at Google, newest first. */
export function putFixtureReview(id: string, star: GbpReview["starRating"], comment: string | null, day: number, name?: string) {
  setScenario(SA, (s) => {
    const list = s.reviews[LOC_A].reviews.filter((r) => r.reviewId !== id);
    list.push(fixtureReview(id, star, comment, day, name));
    list.sort((a, b) => b.updateTime.localeCompare(a.updateTime));
    s.reviews[LOC_A].reviews = list;
  });
}

export const patchSub = (patch: Record<string, unknown>) =>
  mem.seed(`subAccounts/${SA}`, { ...mem.read(`subAccounts/${SA}`)!, ...patch });

export function patchSettings(patch: Record<string, unknown>) {
  const cur = mem.read(`subAccounts/${SA}`)!.reviewsAutoReply as Record<string, unknown>;
  patchSub({ reviewsAutoReply: { ...cur, ...patch } });
}

/**
 * Fresh store, the kill switch set, all three gates on, auto-reply enabled as
 * above. OTHER_SA selects the OTHER fixture location: a location shared by two
 * sub-accounts pauses auto-reply (listing_shared).
 */
export function resetAutoReply() {
  resetSync();
  const other = mem.read(`subAccounts/${OTHER_SA}`)!;
  mem.seed(`subAccounts/${OTHER_SA}`, { ...other, googleListing: { ...(other.googleListing as object), locationName: LOC_NORTH } });
  process.env.REVIEWS_AI_PROVIDER = "fake";
  process.env.REVIEWS_AI_FAKE_AGENCY_ID = AGENCY;
  process.env.REVIEWS_AUTO_REPLY_ENABLED = "1";
  putFixtureReview("fake-a1", 5, null, 28);
  putFixtureReview("fake-a2", 4, "   ", 26);
  patchSub({
    reviewsAiEnabledByAgency: true,
    reviewsAutoReplyEnabledByAgency: true,
    reviewsAutoReply: {
      enabled: true, modes: { 1: "approval", 2: "approval", 3: "approval", 4: "auto", 5: "auto" }, includeBacklog: false,
      enabledAt: ENABLED_AT, enabledByUid: "uid_admin", listingLocationName: LOC_A, updatedAt: ENABLED_AT, updatedByUid: "uid_admin",
    },
  });
}

export const sync = () => syncListing(SA, { trigger: "manual", actorUid: "uid_admin" });

/** A sync, then the engine for it — as the after-response hook runs them. */
export async function syncAndRun(deadline = Date.now() + 240_000) {
  const run = await sync();
  return autoReplyAfterSync(SA, run.startedAt, deadline);
}

export const posts = () => calls(SA).filter((c) => c.op === "putReply");
export const draftsMade = () => ((mem.read(fakeLogPath(SA))?.drafts ?? []) as unknown[]).length;
export const reviewDoc = (reviewId: string) => mem.read(reviewPath(reviewId)) ?? {};
export const pendingOf = (reviewId: string) => reviewDoc(reviewId).pendingReply as
  | { text: string | null; textHash: string | null; basisHash: string; reason: string; model: string | null }
  | null
  | undefined;
export const replyOf = (reviewId: string) => (reviewDoc(reviewId).reply as { comment: string } | null | undefined)?.comment ?? null;
export const reviewNameOf = (reviewId: string) => `${ACCOUNT}/${LOC_A}/reviews/${reviewId}`;

/** The account-independent key (sha256 of `locations/…/reviews/{id}`), computed here from the spec. */
export const stableKeyOf = (reviewId: string) =>
  createHash("sha256").update(`${LOC_A}/reviews/${reviewId}`).digest("hex").slice(0, 40);
export const neverPath = (reviewId: string, sa = SA) => `subAccounts/${sa}/autoReplyNever/${stableKeyOf(reviewId)}`;
export const dismissedPath = (reviewId: string, sa = SA) => `subAccounts/${sa}/autoReplyDismissed/${stableKeyOf(reviewId)}`;
