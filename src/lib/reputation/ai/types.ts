/** The Reviews AI seam (SP5 b sentiment, SP5 c reply drafts). */

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
 * Why an item was not labelled. `call_failed` — any failed call except a 403
 * (no response, timeout, key, credits, invalid model, rate, 5xx, an empty or
 * error body): transient, retried after an hour, never a strike.
 * `call_rejected` — HTTP 403, the provider refusing this review: a strike.
 * `bad_output` — a 200 whose content we cannot use: a strike. The run stops
 * on its first failure of any kind.
 */
export type SentimentFailure = "call_failed" | "call_rejected" | "bad_output";
export type SentimentResult =
  | { id: string; label: SentimentLabel; failure?: undefined }
  | { id: string; label: null; failure: SentimentFailure };

/** One review to draft an owner reply for. `comment` is untrusted customer content. */
export interface DraftInput {
  starRating: number;
  comment: string | null;
  reviewerFirstName: string | null;
  businessName: string;
  /** The sub-account's reply guidelines (tone, sign-off, never-say), or null. */
  guidelines: string | null;
}
/** A draft, or why there is none (same billing meaning as SentimentFailure). */
export type DraftResult = { text: string; failure?: undefined } | { text: null; failure: SentimentFailure };

export interface ReviewsAi {
  /** The model a label is attributed to ("fake" for the dev/CI fake). */
  model: string;
  /** One result per item, in order. Nothing is guessed: an item is labelled or says why not. */
  classifySentiment(items: SentimentItem[]): Promise<SentimentResult[]>;
  /** A reply DRAFT for the admin to edit. It never posts anything anywhere. */
  draftReply(input: DraftInput): Promise<DraftResult>;
}
