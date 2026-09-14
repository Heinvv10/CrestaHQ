/** The Reviews AI seam (SP5 b) — one method today; reply drafts join in PR (c). */

export const SENTIMENT_LABELS = ["positive", "neutral", "negative"] as const;
export type SentimentLabel = (typeof SENTIMENT_LABELS)[number];

/** One review to classify. `text` is untrusted customer content. */
export interface SentimentItem {
  id: string;
  starRating: number;
  text: string;
}

export interface ReviewsAi {
  /** The model a label is attributed to ("fake" for the dev/CI fake). */
  model: string;
  /**
   * Labels for the items the model answered validly. An item missing from
   * the result was NOT labelled this round (bad output, failed call) — the
   * caller leaves it for a later run; nothing is guessed.
   */
  classifySentiment(items: SentimentItem[]): Promise<Array<{ id: string; label: SentimentLabel }>>;
}
