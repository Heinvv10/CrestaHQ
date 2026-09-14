/** The Reviews AI seam (SP5 b) — one method today; reply drafts join in PR (c). */

export const SENTIMENT_LABELS = ["positive", "neutral", "negative"] as const;

/**
 * Reviews per AI call — ONE, deliberately: text from one member of the public
 * must never sit in the same prompt as another review it could try to steer.
 * The classifier and the caller both batch by this.
 */
export const REVIEWS_AI_BATCH = 1;
export type SentimentLabel = (typeof SENTIMENT_LABELS)[number];

/** One review to classify. `text` is untrusted customer content. */
export interface SentimentItem {
  id: string;
  starRating: number;
  text: string;
}

/**
 * A failed item says why — for the logs only. Every failed call counts as a
 * strike on the review (no "was it billed?" guessing), and the run stops on
 * its first failure (sentiment.ts), so an outage costs one strike per run.
 */
export type SentimentFailure = "call_failed" | "bad_output";
export type SentimentResult =
  | { id: string; label: SentimentLabel; failure?: undefined }
  | { id: string; label: null; failure: SentimentFailure };

export interface ReviewsAi {
  /** The model a label is attributed to ("fake" for the dev/CI fake). */
  model: string;
  /** One result per item, in order. Nothing is guessed: an item is labelled or says why not. */
  classifySentiment(items: SentimentItem[]): Promise<SentimentResult[]>;
}
