import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { autoReplyNeverPath } from "@/lib/gbp/auto-reply-never";
import { everReplied, QUEUED_REASONS } from "@/lib/gbp/reply-auto-guard";
import { reviewsCollection, toMillis } from "@/lib/gbp/sync/types";
import { reviewBasis } from "../sentiment-basis";
import { isTexted } from "./decide";
import { autoReplyKillSwitchOn } from "./kill-switch";
import { readAutoReplySettings, AUTO_REPLY_DAILY_POST_CAP } from "./settings";
import {
  AUTO_REPLY_LEASE_TTL_MS, autoReplyLeasePath, autoReplyUsagePath, readPending, sastDay,
} from "./store";

/**
 * The LAST check before an automatic post (AUTO_REPLY_V1_PLAN.md step 4), in
 * one transaction that also counts the post against the 20 a SAST day (a
 * failed post is not refunded) and renews the run's lease:
 *
 *   lease_lost   another run owns the sub-account now          → stop the run
 *   paused       kill switch unset, any of the three gates off, auto-reply
 *                off, the listing changed, or ANOTHER sub-account has selected
 *                the same Google location (its replies are not in this
 *                cache); the draft stays queued and posts when auto-reply
 *                resumes                                        → stop the run
 *   cap          20 posts today; the draft stays queued        → stop the run
 *   stale        the review changed, has or ever had a reply, was removed, or
 *                its draft is no longer this queued text (a Discard wins) → skip it
 *   approval     its star was switched to Approval, it has text, or auto-reply
 *                was switched off and on since (backlog off, review older) —
 *                the draft is kept and now waits for a person   → skip it
 *   go           post it
 */

export type Confirm = "go" | "lease_lost" | "paused" | "cap" | "stale" | "approval";

export async function confirmAutoPost(
  sa: string,
  p: { runId: string; docId: string; textHash: string },
  now: number,
): Promise<Confirm> {
  const db = getAdminDb();
  const leaseRef = db.doc(autoReplyLeasePath(sa));
  const subRef = db.doc(`subAccounts/${sa}`);
  const reviewRef = db.doc(`${reviewsCollection(sa)}/${p.docId}`);
  const usageRef = db.doc(autoReplyUsagePath(sa));
  return db.runTransaction(async (tx): Promise<Confirm> => {
    const lease = (await tx.get(leaseRef)).data() as { runId?: string | null } | undefined;
    const sub = ((await tx.get(subRef)).data() ?? {}) as Record<string, unknown>;
    const review = (await tx.get(reviewRef)).data() as Record<string, unknown> | undefined;
    const usage = (await tx.get(usageRef)).data() as { day?: string; posts?: number } | undefined;
    const never = (await tx.get(db.doc(autoReplyNeverPath(sa, p.docId)))).exists;
    const listing = (sub.googleListing as { locationName?: unknown } | null | undefined)?.locationName;
    const sharing = typeof listing === "string"
      ? ((await tx.get(db.collection("subAccounts").where("googleListing.locationName", "==", listing))) as FirebaseFirestore.QuerySnapshot)
        .docs.some((d) => d.id !== sa)
      : false;

    if (lease?.runId !== p.runId) return "lease_lost";
    if (!autoReplyKillSwitchOn()) return "paused";
    if (sub.googleEnabledByAgency !== true || sub.reviewsAiEnabledByAgency !== true) return "paused";
    if (sub.reviewsAutoReplyEnabledByAgency !== true) return "paused";
    const raw = (sub.reviewsAutoReply ?? {}) as { enabledAt?: unknown; listingLocationName?: unknown };
    const settings = readAutoReplySettings(raw);
    if (!settings.enabled) return "paused";
    if (typeof listing !== "string" || raw.listingLocationName !== listing || sharing) return "paused";

    const pending = readPending(review?.pendingReply);
    const basis = review ? reviewBasis(review) : null;
    if (!review || review.state !== "active" || review.locationName !== listing || everReplied(review) || never) return "stale";
    if (!pending || !QUEUED_REASONS.includes(pending.reason) || pending.textHash !== p.textHash) return "stale";
    if (basis === null || pending.basisHash !== basis) return "stale";

    const star = review.starRating as 1 | 2 | 3 | 4 | 5;
    const enabledAt = toMillis(raw.enabledAt);
    const createdAt = toMillis(review.createTime);
    const beforeEnabled = !settings.includeBacklog && (enabledAt === null || createdAt === null || createdAt < enabledAt);
    if (settings.modes[star] !== "auto" || isTexted(review.comment as string | null) || beforeEnabled) {
      tx.update(reviewRef, { "pendingReply.reason": isTexted(review.comment as string | null) ? "texted" : "approval" });
      return "approval";
    }

    const day = sastDay(now);
    const posts = usage?.day === day ? (usage.posts ?? 0) : 0;
    if (posts >= AUTO_REPLY_DAILY_POST_CAP) return "cap";
    tx.set(usageRef, { day, posts: posts + 1 }, { merge: true });
    tx.set(leaseRef, { until: now + AUTO_REPLY_LEASE_TTL_MS }, { merge: true });
    return "go";
  });
}
