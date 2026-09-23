import type { FieldValue, Timestamp } from "firebase/firestore";

import type { MandateConsent } from "@/types/payment-mandates";

/**
 * Paystack charge attempts — `paymentAttempts/{reference}`.
 *
 * One doc per checkout (and, later, per mandate charge), written server-side
 * BEFORE Paystack is called. The doc id is the Paystack reference.
 *
 * Test vs live is a property of the ATTEMPT: `mode` and `keyFingerprint`
 * record the key the checkout was opened with. The webhook marks nothing paid
 * unless the key that verified the transaction, and the transaction's own
 * domain, match them. When the connection is disconnected or switched while
 * an attempt is open, the attempt is flagged for the operator rather than
 * left to vanish.
 *
 * Top-level with tenancy keys: member-read, server-only writes.
 */

export type PaymentMode = "test" | "live";

/**
 * open     — checkout started; no outcome yet.
 * settled  — a verified payment was recorded against it.
 * refused  — no money was taken: Paystack never opened the checkout, or said
 *            (when asked before a key change) that it ended unpaid.
 * flagged  — money may exist that was NOT recorded; `reason` tells the
 *            operator what to check. Still settles if a matching verified
 *            payment later arrives (e.g. the same key is reconnected).
 */
export type PaymentAttemptState = "open" | "settled" | "refused" | "flagged";

export interface PaymentAttempt {
  /** The Paystack reference — also the doc id. */
  id: string;

  agencyId: string;
  subAccountId: string;
  /** The operator who issued the link. The payer has no account. */
  createdByUid: string;

  /** What the attempt pays. */
  paymentLinkId: string | null;

  amountCents: number;
  currency: string;

  /**
   * A card-on-file checkout: the terms shown, when the customer clicked pay,
   * and from where. Copied onto the mandate the payment creates.
   */
  consent?: MandateConsent | null;

  mode: PaymentMode;
  /** `paystackKeyFingerprint` of the key the checkout was opened with. */
  keyFingerprint: string;

  state: PaymentAttemptState;
  reason: string | null;

  createdAt: Timestamp | FieldValue;
  updatedAt: Timestamp | FieldValue;
}
