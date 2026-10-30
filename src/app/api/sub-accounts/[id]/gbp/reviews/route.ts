import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { googleGateOn } from "@/lib/google/gate";
import { applyReviewFilters, parseReviewFilters } from "@/lib/gbp/inbox-filters";
import { allListings, isMain } from "@/lib/gbp/listings";
import { gbpRefusal } from "@/lib/gbp/route-support";
import { heldByAnotherSubAccount } from "@/lib/gbp/shared-location";
import { publicReview, publicRun, publicSummary } from "@/lib/gbp/sync/public";
import { gbpSyncScheduled } from "@/lib/gbp/sync/schedule";
import { summaryIn, type WithSummaries } from "@/lib/gbp/sync/scope";
import { loadServedReviews } from "@/lib/gbp/sync/served";
import { reviewsAiConfigured } from "@/lib/reputation/ai/mode";
import { needsApproval } from "@/lib/reputation/auto-reply/approval";
import { autoReplyKillSwitchOn } from "@/lib/reputation/auto-reply/kill-switch";
import { readAutoReplyListings, readAutoReplySettings } from "@/lib/reputation/auto-reply/settings";
import { runsCollection } from "@/lib/gbp/sync/types";
import type { AutoReplyStar, SubAccountDoc } from "@/types";

/**
 * GET /api/sub-accounts/[id]/gbp/reviews — the synced reviews of every
 * connected listing combined (MULTI_LISTING_V1_PLAN.md PR 4), or of the one
 * `?listing=` names (a current listing of THIS sub-account, else 400
 * `invalid_filter` field `listing`), newest first, each labelled with its
 * listing — at most 500 records per listing, `truncated` says when a cap was
 * hit; the selected listing's summary (main's for "All") with health derived
 * NOW from the live connection; `listings` (`[{locationName, title, main}]`,
 * for the page's dropdown); the last 10 runs; whether this deployment
 * schedules syncs; and how many of the served reviews hold an auto-reply draft
 * waiting for a person (`needsApproval`; filter `approval=needed`; each
 * review's `approval` carries only its reason and draft text). Nothing older
 * than Google's 30-day storage limit is served, whether or not a sync has
 * purged it yet (`withinRetention`, the same rule the sync applies). Any
 * active member (read-only collaborators included); agency-gated. Admin SDK
 * only — the review collections have no client rules.
 */

const RUN_CAP = 10;

/**
 * Whether auto-reply would post a star of a review on its listing right now —
 * the kill switch, all three gates, switched on for THAT listing
 * (`readAutoReplyListings`: main and/or extras, MULTI_LISTING_V1_PLAN.md PR 6),
 * no other sub-account managing that location (`listing_shared` pauses
 * posting — asked per listing), the star on Auto. A queued draft it would not
 * post is shown as "Auto-post paused".
 */
async function autoPostsFor(id: string, sub: SubAccountDoc): Promise<(star: number, reviewLocation: unknown) => boolean> {
  const raw = sub.reviewsAutoReply;
  const settings = readAutoReplySettings(raw);
  const gatesOn = autoReplyKillSwitchOn() && sub.googleEnabledByAgency === true && sub.reviewsAiEnabledByAgency === true
    && sub.reviewsAutoReplyEnabledByAgency === true;
  const on = new Set<string>();
  if (gatesOn) {
    for (const loc of Object.keys(readAutoReplyListings(raw, sub))) {
      if (!(await heldByAnotherSubAccount(getAdminDb(), null, loc, id))) on.add(loc);
    }
  }
  return (star, reviewLocation) =>
    typeof reviewLocation === "string" && on.has(reviewLocation) && settings.modes[star as AutoReplyStar] === "auto";
}

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const access = await requireSubAccountMember(request, id);
  if (access instanceof NextResponse) return access;
  if (!(await googleGateOn(id))) {
    return gbpRefusal(403, "gate_off", "This feature is locked by your agency.");
  }

  const db = getAdminDb();
  const sub = ((await db.doc(`subAccounts/${id}`).get()).data() ?? {}) as SubAccountDoc & WithSummaries;
  const listings = allListings(sub);
  const parsed = parseReviewFilters(new URL(request.url).searchParams, listings.map((l) => l.locationName));
  if (!parsed.ok) {
    return NextResponse.json(
      { error: `Invalid filter: ${parsed.field}`, code: "invalid_filter", field: parsed.field },
      { status: 400 },
    );
  }

  const locationName = sub.googleListing?.locationName ?? null;
  const selected = parsed.filters.listing;
  const now = new Date();
  const [served, runSnap] = await Promise.all([
    loadServedReviews(id, selected ? [selected] : listings.map((l) => l.locationName), now),
    db.collection(runsCollection(id)).orderBy("finishedAt", "desc").limit(RUN_CAP).get(),
  ]);

  const active = served.reviews;
  const autoPosts = await autoPostsFor(id, sub);
  const titles = new Map(listings.map((l) => [l.locationName, l.title]));
  const reviews = applyReviewFilters(active, parsed.filters).map((d) => {
    const loc = String(d.locationName ?? "");
    return publicReview(d, (star) => autoPosts(star, d.locationName), { locationName: loc, title: titles.get(loc) ?? "" });
  });
  // The selected listing's summary; "All" shows the main listing's.
  const summaryLoc = selected ?? locationName;
  const stored = summaryLoc ? summaryIn(sub, isMain(sub, summaryLoc) ? null : summaryLoc) : null;
  const summary =
    summaryLoc && stored?.locationName === summaryLoc
      ? publicSummary(stored, now, { reconnectRequired: sub.googleConnectionMeta?.reconnectRequired })
      : null;

  return NextResponse.json({
    summary,
    reviews,
    /** Active reviews before the filters — the page's "N of M". */
    available: active.length,
    /** Of those, the ones "Needs approval" shows (auto-reply drafts waiting for a person). */
    needsApproval: active.filter(needsApproval).length,
    // Counted over records (tombstones included — filtering them in the query
    // would need a composite index), so the list may hold fewer than 500.
    truncated: served.truncated,
    runs: runSnap.docs.map((d) => publicRun(d.data())),
    scheduled: gbpSyncScheduled(),
    /** "Draft with AI" can work: the Google gate (checked above), the Reviews AI gate, and AI configured here. */
    aiDrafts: sub.reviewsAiEnabledByAgency === true && reviewsAiConfigured(),
    /** The connected listings, main first — the page's listing dropdown. */
    listings: listings.map((l) => ({ locationName: l.locationName, title: l.title, main: isMain(sub, l.locationName) })),
  });
}
