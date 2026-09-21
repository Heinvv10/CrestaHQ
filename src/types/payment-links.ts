import type { FieldValue, Timestamp } from "firebase/firestore";

/**
 * Paystack payment links — `paymentLinks/{id}`.
 *
 * One doc per link. A sub-account operator creates it; the customer opens
 * `/pay/link/{token}` and pays on Paystack, into the SUB-ACCOUNT's own Paystack
 * balance (`subAccounts/{id}/private/paystackConnection`), never the agency's.
 *
 * `invoiceId` set → the link pays that invoice (a `quotes` doc with
 * kind "invoice"), and a verified payment also marks the invoice paid through
 * `markQuotePaidServerSide`. Absent → an ad-hoc amount the operator typed.
 * Both kinds go through the same reconciler.
 *
 * `status` flips to "paid" ONLY in the Paystack webhook, after the transaction
 * is re-verified against Paystack with the tenant's key. The customer's return
 * to the pay page after checkout never writes anything.
 *
 * Top-level with tenancy keys, like `orders`: member-read, server-only writes.
 */

export type PaymentLinkStatus = "open" | "paid";

/** Paystack settles this deployment in ZAR; nothing else is offered. */
export const PAYMENT_LINK_CURRENCY = "ZAR";

export interface PaymentLinkExtraPayment {
  reference: string;
  amountCents: number;
  paidAt: Timestamp | Date;
}

export interface PaymentLink {
  id: string;

  agencyId: string;
  subAccountId: string;
  createdByUid: string;

  /** The invoice this link pays. Null for an ad-hoc link. */
  invoiceId: string | null;
  /** The invoice's contact, for display. Null for an ad-hoc link. */
  contactId: string | null;

  /** What the payer sees on the pay page and on Paystack's checkout. */
  description: string;
  /** Integer cents. The ONLY amount ever sent to Paystack for this link. */
  amountCents: number;
  currency: typeof PAYMENT_LINK_CURRENCY;

  /**
   * The Paystack key's mode when the link was made (`sk_live_` vs `sk_test_`).
   * A test link takes no real money; the pay page and list say so, and the
   * reconciler refuses a transaction from the other mode.
   */
  livemode: boolean;
  /** Paystack's `domain` ("test" | "live") on the verified transaction. */
  paystackDomain?: string | null;
  /**
   * Set when the invoice step finished — invoice marked paid, already paid,
   * or refused with `attention`. Unset on a paid invoice link means the step
   * never finished, and a redelivery runs it again.
   */
  invoiceSettledAt?: Timestamp | FieldValue | Date | null;

  /** Signed path segment of the public URL, `/pay/link/{token}`. */
  token: string;
  /** False once the operator deactivates it. A deactivated link opens no
   *  new checkout; a payment already in flight still records. */
  active: boolean;

  status: PaymentLinkStatus;
  /** The Paystack transaction reference that paid it. */
  paystackReference: string | null;
  payerEmail: string | null;
  paidAt: Timestamp | FieldValue | null;
  /**
   * Further successful payments after the first — the customer paid twice
   * (two tabs). Money the operator owes back; shown as "refund owed".
   */
  extraPayments?: PaymentLinkExtraPayment[];
  /**
   * Set when the money arrived but the invoice could not be marked paid
   * (edited, voided, already paid another way). The operator must act.
   */
  attention?: string | null;

  createdAt: Timestamp | FieldValue;
  updatedAt: Timestamp | FieldValue;
}
