import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { googleGateOn } from "@/lib/google/gate";
import { gbpRefusal } from "@/lib/gbp/route-support";
import { publicReview, publicRun, publicSummary } from "@/lib/gbp/sync/public";
import { withinRetention } from "@/lib/gbp/sync/reconcile";
import { gbpSyncScheduled } from "@/lib/gbp/sync/schedule";
import { reviewsCollection, runsCollection, type GbpSummary } from "@/lib/gbp/sync/types";
import type { SubAccountDoc } from "@/types";

/**
 * GET /api/sub-accounts/[id]/gbp/reviews — the synced reviews of the selected
 * listing (newest first, at most 500 records — `truncated` says when the cap
 * was hit), the summary with health derived NOW from the live connection,
 * the last 10 runs, and whether this deployment schedules syncs. Nothing
 * older than Google's 30-day storage limit is served, whether or not a sync
 * has purged it yet (`withinRetention`, the same rule the sync applies). Any active member (read-only collaborators included);
 * agency-gated. Admin SDK only — the review collections have no client rules.
 *
 * Single-field queries only (no composite index): active/listing filtering
 * happens here, which is cheap because the collection only ever holds the
 * current listing (a listing change clears it) plus tombstones younger than
 * 30 days.
 */

const REVIEW_CAP = 500;
const RUN_CAP = 10;

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
  const sub = ((await db.doc(`subAccounts/${id}`).get()).data() ?? {}) as SubAccountDoc & {
    gbpSummary?: GbpSummary | null;
  };
  const locationName = sub.googleListing?.locationName ?? null;
  const now = new Date();
  const [reviewSnap, runSnap] = await Promise.all([
    db.collection(reviewsCollection(id)).orderBy("createTime", "desc").limit(REVIEW_CAP).get(),
    db.collection(runsCollection(id)).orderBy("finishedAt", "desc").limit(RUN_CAP).get(),
  ]);

  const reviews = locationName
    ? reviewSnap.docs
        .map((d) => d.data() as Record<string, unknown>)
        .filter((d) => d.state === "active" && d.locationName === locationName && withinRetention(d.lastSeenAt, now))
        .map(publicReview)
    : [];
  const summary =
    locationName && sub.gbpSummary?.locationName === locationName
      ? publicSummary(sub.gbpSummary, now, { reconnectRequired: sub.googleConnectionMeta?.reconnectRequired })
      : null;

  return NextResponse.json({
    summary,
    reviews,
    // Counted over records (tombstones included — filtering them in the query
    // would need a composite index), so the list may hold fewer than 500.
    truncated: reviewSnap.size >= REVIEW_CAP,
    runs: runSnap.docs.map((d) => publicRun(d.data())),
    scheduled: gbpSyncScheduled(),
  });
}
