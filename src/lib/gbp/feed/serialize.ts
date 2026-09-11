import { toMillis } from "@/lib/gbp/sync/types";

/**
 * The public feed body, contract v1 (docs/features/gbp-reviews.md). Explicit
 * allow-list serializers — NEVER a spread of a Firestore doc — so resource
 * names (`accounts/…`, `locations/…`), the Place ID, tenant ids, uids,
 * emails, passId, contentHash, tokens and run diagnostics cannot reach a
 * public website, however the stored docs grow.
 */

export type FeedStatus = "ok" | "stale" | "unavailable";

export interface FeedReview {
  /** The gbpReviews doc id (a hash) — not Google's review name or id. */
  id: string;
  author: { name: string; photoUrl: string | null; anonymous: boolean };
  rating: number;
  /** Byte-exact, incl. Google's "(Translated by Google) … (Original) …" block. */
  text: string | null;
  createdAt: string;
  updatedAt: string;
  reply: { text: string; updatedAt: string } | null;
}

export interface FeedBody {
  version: 1;
  status: FeedStatus;
  /** Null only when the sub-account no longer has a listing (then `unavailable`). */
  listing: { title: string; mapsUri: string | null; writeReviewUri: string | null } | null;
  rating: { average: number; count: number } | null;
  source: { name: "Google"; attribution: "Reviews from Google" };
  freshness: { lastSuccessfulSyncAt: string | null; stale: boolean; generatedAt: string };
  reviews: FeedReview[];
}

export const FEED_SOURCE = { name: "Google", attribution: "Reviews from Google" } as const;

const iso = (v: unknown): string | null => {
  const ms = toMillis(v);
  return ms === null ? null : new Date(ms).toISOString();
};
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function feedReview(id: string, d: Record<string, unknown>): FeedReview {
  const reviewer = (d.reviewer ?? null) as Record<string, unknown> | null;
  const reply = (d.reply ?? null) as Record<string, unknown> | null;
  const anonymous = reviewer?.isAnonymous === true;
  return {
    id,
    // An anonymous reviewer gets no photo, whatever Google sent.
    author: { name: str(reviewer?.displayName) ?? "", photoUrl: anonymous ? null : str(reviewer?.profilePhotoUrl), anonymous },
    rating: Number(d.starRating),
    text: str(d.comment),
    createdAt: iso(d.createTime) ?? "",
    updatedAt: iso(d.updateTime) ?? "",
    reply: reply && typeof reply.comment === "string" ? { text: reply.comment, updatedAt: iso(reply.updateTime) ?? "" } : null,
  };
}

export function feedListing(l: Record<string, unknown> | null | undefined): FeedBody["listing"] {
  if (!l) return null;
  return { title: str(l.title) ?? "", mapsUri: str(l.mapsUri), writeReviewUri: str(l.newReviewUri) };
}
