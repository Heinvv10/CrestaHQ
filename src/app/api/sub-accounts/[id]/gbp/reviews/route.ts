import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { googleGateOn } from "@/lib/google/gate";
import { applyReviewFilters, parseReviewFilters } from "@/lib/gbp/inbox-filters";
import { gbpRefusal } from "@/lib/gbp/route-support";
import { publicReview, publicRun, publicSummary } from "@/lib/gbp/sync/public";
import { gbpSyncScheduled } from "@/lib/gbp/sync/schedule";
import { loadServedReviews } from "@/lib/gbp/sync/served";
import { reviewsAiConfigured } from "@/lib/reputation/ai/mode";
import { needsApproval } from "@/lib/reputation/auto-reply/approval";
import { autoReplyKillSwitchOn } from "@/lib/reputation/auto-reply/kill-switch";
import { readAutoReplySettings } from "@/lib/reputation/auto-reply/settings";
import { runsCollection, type GbpSummary } from "@/lib/gbp/sync/types";
import type { AutoReplyStar, SubAccountDoc } from "@/types";

/**
 * GET /api/sub-accounts/[id]/gbp/reviews — the synced reviews of the selected
 * listing (newest first, at most 500 records — `truncated` says when the cap
 * was hit), the summary with health derived NOW from the live connection,
 * the last 10 runs, whether this deployment schedules syncs, and how many
 * reviews hold an auto-reply draft waiting for a person (`needsApproval`;
 * filter `approval=needed`; each review's `approval` carries only its reason
 * and draft text). Nothing
 * older than Google's 30-day storage limit is served, whether or not a sync
 * has purged it yet (`withinRetention`, the same rule the sync applies). Any active member (read-only collaborators included);
 * agency-gated. Admin SDK only — the review collections have no client rules.
 *
 * Single-field queries only (no composite index): active/listing filtering
 * happens here, which is cheap because the collection only ever holds the
 * current listing (a listing change clears it) plus tombstones younger than
 * 30 days.
 */

const RUN_CAP = 10;

/**
 * Whether auto-reply would post a star right now — the kill switch, all three
 * gates, switched on for THIS listing, no other sub-account on the same
 * location (`listing_shared` pauses posting), the star on Auto. A queued
 * draft it would not post is shown as "Auto-post paused".
 */
async function autoPostsFor(id: string, sub: SubAccountDoc, locationName: string | null): Promise<(star: number) => boolean> {
  const raw = sub.reviewsAutoReply;
  const settings = readAutoReplySettings(raw);
  let on = autoReplyKillSwitchOn() && sub.googleEnabledByAgency === true && sub.reviewsAiEnabledByAgency === true
    && sub.reviewsAutoReplyEnabledByAgency === true && settings.enabled
    && !!locationName && raw?.listingLocationName === locationName;
  if (on) {
    const same = await getAdminDb().collection("subAccounts").where("googleListing.locationName", "==", locationName).get();
    on = !same.docs.some((d) => d.id !== id);
  }
  return (star) => on && settings.modes[star as AutoReplyStar] === "auto";
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

  const parsed = parseReviewFilters(new URL(request.url).searchParams);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: `Invalid filter: ${parsed.field}`, code: "invalid_filter", field: parsed.field },
      { status: 400 },
    );
  }

  const db = getAdminDb();
  const sub = ((await db.doc(`subAccounts/${id}`).get()).data() ?? {}) as SubAccountDoc & {
    gbpSummary?: GbpSummary | null;
  };
  const locationName = sub.googleListing?.locationName ?? null;
  const now = new Date();
  const [served, runSnap] = await Promise.all([
    loadServedReviews(id, locationName, now),
    db.collection(runsCollection(id)).orderBy("finishedAt", "desc").limit(RUN_CAP).get(),
  ]);

  const active = served.reviews;
  const autoPosts = await autoPostsFor(id, sub, locationName);
  const reviews = applyReviewFilters(active, parsed.filters).map((d) => publicReview(d, autoPosts));
  const summary =
    locationName && sub.gbpSummary?.locationName === locationName
      ? publicSummary(sub.gbpSummary, now, { reconnectRequired: sub.googleConnectionMeta?.reconnectRequired })
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
  });
}
