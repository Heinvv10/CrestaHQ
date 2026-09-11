import { shortDate } from "./format-time";

/** The public review shape GET /gbp/reviews returns (lib/gbp/sync/public.ts). */
export interface ReviewView {
  reviewId: string;
  reviewer: { displayName: string; profilePhotoUrl: string | null; isAnonymous: boolean } | null;
  starRating: number;
  comment: string | null;
  createTime: string | null;
  updateTime: string | null;
  reply: { comment: string; updateTime: string } | null;
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
export function ReviewItem({ review }: { review: ReviewView }) {
  const name =
    !review.reviewer || review.reviewer.isAnonymous || !review.reviewer.displayName
      ? "Anonymous"
      : review.reviewer.displayName;
  return (
    <li className="rounded-xl border p-4" data-testid={`gbp-review-${review.reviewId}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <span className="font-medium">{name}</span>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
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
        <div className="mt-3 rounded-lg bg-muted/50 p-3 text-sm" data-testid="gbp-review-reply">
          <p className="text-xs font-medium text-muted-foreground">Owner reply</p>
          <p className="mt-1 whitespace-pre-wrap break-words">{review.reply.comment}</p>
        </div>
      )}
    </li>
  );
}
