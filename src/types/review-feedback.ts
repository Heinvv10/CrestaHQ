/**
 * Review feedback — what a customer left on the public `/r/[token]` page.
 *
 * COMPLIANCE NOTE, and the reason this type has no "gate" field:
 *
 * Google's Maps user-generated-content policy prohibits *review gating* —
 * showing the Google review link only to customers who rate you highly, and
 * diverting unhappy ones to a private form instead. Google began actively
 * enforcing this with the April 2026 policy update; penalties include review
 * removal and reduced profile visibility.
 *
 * So the page shows every customer the same Google review link, unconditionally
 * and before they rate anything. The optional star rating and comment captured
 * here are an *addition*, never a filter: a 1-star response and a 5-star
 * response see an identical page. The commercial value is the internal alert —
 * the owner learns about an unhappy customer in minutes rather than reading it
 * on Google a week later — not suppression of the review itself.
 *
 * If a future change makes the Google link conditional on `rating`, that is a
 * policy violation. Don't.
 */
export interface ReviewFeedbackDoc {
  id: string;

  /** Tenancy — stamped server-side from the contact, never from the client. */
  agencyId: string;
  subAccountId: string;
  contactId: string;

  /** 1–5 if the customer rated, null if they only left a comment or only
   *  clicked through to Google. */
  rating: number | null;

  /** Free-text feedback. Trimmed, length-capped, never rendered as HTML. */
  comment: string;

  /** True once the customer has clicked the Google review link. Recorded for
   *  reporting only — it does not gate anything. */
  clickedGoogle: boolean;

  /** Set when the submission opened an internal follow-up task. */
  taskId: string | null;

  /** Coarse provenance, for abuse triage on a public endpoint. Nulled by the
   *  daily api-cleanup sweep once `piiExpiresAt` passes — the rating and
   *  comment are kept forever, only the identifying fields age out. */
  submittedFromIp: string | null;
  submittedUserAgent: string | null;

  /** When the two fields above become scrubbable. Set to null by the sweep,
   *  which is what excludes an already-scrubbed row from later runs. */
  piiExpiresAt: Date | null;

  createdAt: FirebaseFirestore.Timestamp | Date;
}

/** Ratings at or below this open an internal follow-up task and notify the
 *  owner. It does NOT change what the customer is shown. */
export const REVIEW_FOLLOW_UP_THRESHOLD = 3;

/** Days the abuse-triage IP + user-agent are kept before the daily sweep
 *  nulls them. The customer's rating and comment are never deleted. */
export const REVIEW_PII_RETENTION_DAYS = 30;

/** Hard cap on the free-text comment, enforced server-side. */
export const REVIEW_COMMENT_MAX = 2000;
