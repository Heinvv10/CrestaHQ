/** The Reviews AI seam (SP5 b sentiment, SP5 c reply drafts). */

export const SENTIMENT_LABELS = ["positive", "neutral", "negative"] as const;

/**
 * Reviews per AI call — ONE, deliberately: text from one member of the public
 * must never sit in the same prompt as another review it could try to steer.
 * The classifier and the caller both batch by this.
 */
export const REVIEWS_AI_BATCH = 1;

/**
 * Every Reviews AI call — headers AND body — gets this long (openrouter.ts
 * aborts it then). Here, not there, so the draft seam can read it without
 * importing openrouter.ts back.
 */
export const REVIEWS_AI_CALL_MS = 60_000;
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
/**
 * Why there is no draft — for logs only; the admin just sees "try again or
 * write your own". `slop_deadline` — the first attempt was `slop` and the
 * caller's deadline left no room for the one retry: distinct from `slop` so
 * the auto-reply engine's consecutive-failure count (run.ts) never counts a
 * retry that was never attempted.
 */
export type DraftFailure = "call_failed" | "empty" | "unsupplied_contact" | "slop" | "slop_deadline";
/** A draft, or none. Every attempt counts against the daily AI cap either way (no strikes, no refunds). */
export type DraftResult = { text: string; failure?: undefined } | { text: null; failure: DraftFailure };

export interface ReviewsAi {
  /** The model a label is attributed to ("fake" for the dev/CI fake). */
  model: string;
  /** One result per item, in order. Nothing is guessed: an item is labelled or says why not. */
  classifySentiment(items: SentimentItem[]): Promise<SentimentResult[]>;
  /**
   * A reply DRAFT. It posts nothing itself: "Draft with AI" hands it to the
   * admin to edit; review auto-reply (lib/reputation/auto-reply), when a
   * sub-account switched it on, may post it to Google without a click.
   * `deadlineMs` (auto-reply's run deadline): no voice retry without room for it.
   */
  draftReply(input: DraftInput, deadlineMs?: number): Promise<DraftResult>;
}
