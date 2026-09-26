import { Frown, Meh, Smile } from "lucide-react";
import type { ApprovalState } from "@/lib/reputation/auto-reply/approval";
import { shortDate } from "./format-time";

/** The public review shape GET /gbp/reviews returns (lib/gbp/sync/public.ts). */
export interface ReviewView {
  reviewId: string;
  /** Cache doc id — the reply route's address for this review. */
  docId: string;
  reviewer: { displayName: string; profilePhotoUrl: string | null; isAnonymous: boolean } | null;
  starRating: number;
  comment: string | null;
  createTime: string | null;
  updateTime: string | null;
  reply: { comment: string; updateTime: string } | null;
  /** SP5 (b): the cached sentiment label, when the review has one. */
  sentiment?: { label: string; method: string } | null;
  /** The reply was posted by review auto-reply. */
  autoReplied?: boolean;
  /** A fresh auto-reply draft waiting for a person: why, and its text for the composer. */
  approval?: { state: ApprovalState; draft: string | null } | null;
}

/** Each "Needs approval" row's reason, as the page says it. */
export const APPROVAL_LABEL: Record<ApprovalState, string> = {
  held: "Held for approval",
  queued: "Queued to auto-post",
  paused: "Auto-post paused",
  draft_failed: "Draft failed",
  over_limit: "Over today's limit",
  post_failed: "Post failed",
};

const SENTIMENT: Record<string, { text: string; Icon: typeof Smile; tone: string }> = {
  positive: { text: "Positive", Icon: Smile, tone: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400" },
  neutral: { text: "Neutral", Icon: Meh, tone: "bg-muted text-muted-foreground" },
  negative: { text: "Negative", Icon: Frown, tone: "bg-red-500/10 text-red-700 dark:text-red-400" },
};

function SentimentBadge({ reviewId, sentiment }: { reviewId: string; sentiment: { label: string; method: string } }) {
  const s = SENTIMENT[sentiment.label];
  if (!s) return null;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${s.tone}`}
      title={sentiment.method === "rating" ? "From the star rating" : "AI-classified"}
      data-testid={`gbp-review-sentiment-${reviewId}`}
      data-label={sentiment.label}
      data-method={sentiment.method}
    >
      <s.Icon className="h-3 w-3" aria-hidden />
      {s.text}
    </span>
  );
}

function Stars({ rating }: { rating: number }) {
  return (
    <span className="text-amber-500" aria-label={`${rating} out of 5 stars`} role="img">
      {"★".repeat(rating)}
      <span className="text-muted-foreground/40">{"★".repeat(Math.max(0, 5 - rating))}</span>
    </span>
  );
}

/**
 * One review exactly as Google returned it: the comment is rendered verbatim
 * in `whitespace-pre-wrap` (never truncated, never rewritten — Google's
 * "(Translated by Google) … (Original) …" block shows as it came).
 */
export function ReviewItem({ review, children }: { review: ReviewView; children?: React.ReactNode }) {
  const name =
    !review.reviewer || review.reviewer.isAnonymous || !review.reviewer.displayName
      ? "Anonymous"
      : review.reviewer.displayName;
  return (
    <li className="rounded-xl border p-4" data-testid={`gbp-review-${review.reviewId}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-medium">{name}</span>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          {review.approval && (
            <span
              className="rounded-full bg-amber-500/10 px-2 py-0.5 font-medium text-amber-700 dark:text-amber-400"
              data-testid={`gbp-review-approval-${review.reviewId}`}
              data-state={review.approval.state}
            >
              {APPROVAL_LABEL[review.approval.state] ?? "Needs approval"}
            </span>
          )}
          {review.sentiment && <SentimentBadge reviewId={review.reviewId} sentiment={review.sentiment} />}
          <Stars rating={review.starRating} />
          {review.createTime && <time dateTime={review.createTime}>{shortDate(review.createTime)}</time>}
        </span>
      </div>
      {review.comment !== null ? (
        <p className="mt-2 whitespace-pre-wrap break-words text-sm" data-testid="gbp-review-comment">
          {review.comment}
        </p>
      ) : (
        <p className="mt-2 text-xs italic text-muted-foreground">Rating only — no written review.</p>
      )}
      {review.reply && (
        <div className="mt-3 rounded-lg bg-muted/50 p-3 text-sm" data-testid={`gbp-review-reply-${review.reviewId}`}>
          <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            Owner reply
            {review.autoReplied && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[11px]" data-testid={`gbp-review-auto-replied-${review.reviewId}`}>
                Auto-replied
              </span>
            )}
          </p>
          <p className="mt-1 whitespace-pre-wrap break-words">{review.reply.comment}</p>
        </div>
      )}
      {children}
    </li>
  );
}
