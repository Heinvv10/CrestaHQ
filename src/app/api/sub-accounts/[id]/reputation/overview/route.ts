import "server-only";

import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/firebase/admin";
import { requireSubAccountMember } from "@/lib/auth/require-tenancy";
import { deriveHealth } from "@/lib/gbp/sync/health";
import { publicSummary } from "@/lib/gbp/sync/public";
import { loadServedReviews } from "@/lib/gbp/sync/served";
import type { GbpSummary } from "@/lib/gbp/sync/types";
import { computeOverview, parseRange, previousPeriodStart } from "@/lib/reputation/overview";
import { resolveReviewUrl } from "@/lib/reviews/canonical-url";
import type { SubAccountDoc } from "@/types";

/**
 * GET /api/sub-accounts/[id]/reputation/overview?range=30d|90d|365d|all —
 * the Reputation overview (SP5 a): aggregates only, never review text.
 * Any active member. Review metrics only with the agency's Google gate on,
 * Google connected and a listing selected (else `reviews: null` and
 * `reviewsUnavailable` says why); the reviews are exactly the inbox's set
 * (`loadServedReviews`). Request metrics come from the server-only
 * `reviewRequests` log and are always returned. Single-field queries only.
 */

/** Log rows read per request — `truncated.requests` says when there were more. */
const REQUEST_CAP = 2000;

export const dynamic = "force-dynamic";

type Unavailable = "gate_off" | "not_connected" | "no_listing";

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const access = await requireSubAccountMember(request, id);
  if (access instanceof NextResponse) return access;

  const range = parseRange(new URL(request.url).searchParams.get("range"));
  if (!range) {
    return NextResponse.json({ error: "Invalid filter: range", code: "invalid_filter", field: "range" }, { status: 400 });
  }

  const db = getAdminDb();
  const now = new Date();
  const sub = ((await db.doc(`subAccounts/${id}`).get()).data() ?? {}) as SubAccountDoc & {
    gbpSummary?: GbpSummary | null;
  };
  const meta = sub.googleConnectionMeta ?? null;
  const locationName = sub.googleListing?.locationName ?? null;
  const unavailable: Unavailable | null =
    sub.googleEnabledByAgency !== true ? "gate_off" : !meta?.connected ? "not_connected" : !locationName ? "no_listing" : null;

  const log = db.collection(`subAccounts/${id}/reviewRequests`);
  const since = previousPeriodStart(range, now);
  const [served, requestSnap, oldestSnap] = await Promise.all([
    unavailable ? null : loadServedReviews(id, locationName, now),
    (since ? log.where("sentAt", ">=", since) : log).orderBy("sentAt", "desc").limit(REQUEST_CAP + 1).get(),
    log.orderBy("sentAt", "asc").limit(1).get(),
  ]);
  const oldestRequestAt = oldestSnap.docs[0]?.data().sentAt ?? null;

  const overview = computeOverview({
    reviews: served ? served.reviews.map((r) => ({ starRating: r.starRating, createTime: r.createTime, reply: r.reply as { updateTime?: unknown } | null })) : null,
    requests: requestSnap.docs.slice(0, REQUEST_CAP).map((d) => {
      const { channel, sentAt, status, source } = d.data();
      return { channel, sentAt, status, source };
    }),
    oldestRequestAt,
    range,
    now,
  });

  const live = { reconnectRequired: meta?.reconnectRequired };
  const summary =
    !unavailable && sub.gbpSummary?.locationName === locationName ? publicSummary(sub.gbpSummary, now, live) : null;

  return NextResponse.json({
    ...overview,
    reviewsUnavailable: unavailable,
    /** Google's own listing figures, only as the reviews inbox serves them. */
    listing: summary ? { averageRating: summary.averageRating, totalReviewCount: summary.totalReviewCount } : null,
    health: unavailable ? null : (summary?.health ?? deriveHealth(null, now, live)),
    lastSuccessfulSyncAt: summary?.lastSuccessfulSyncAt ?? null,
    lastErrorKind: summary?.lastErrorKind ?? null,
    lastReconciliation: summary?.lastReconciliation ?? null,
    truncated: { reviews: served?.truncated ?? false, requests: requestSnap.size > REQUEST_CAP },
    checklist: {
      googleConnected: meta?.connected === true && !meta.reconnectRequired,
      listingSelected: !!locationName,
      reviewLinkConfigured: !!resolveReviewUrl(sub).configured,
      widgetExists: !!sub.gbpWidgetMeta?.publicId,
      requestLogged: oldestRequestAt !== null,
    },
  });
}
