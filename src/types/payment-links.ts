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
   * Paystack's `domain` ("test" | "live") on the verified transaction. There
   * is no per-link mode: the pay page, checkout and reconciler all use the
   * connection's CURRENT mode, so a link made under a test key and paid after
   * the live key is connected is labelled, charged and recorded as live.
   */
  paystackDomain?: string | null;
  /**
   * Set when the invoice step reached an end state — marked paid (by this
   * payment), or refused with `invoiceAttention`. Unset on a paid invoice link
   * means the step never finished, and a redelivery runs it again.
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
   * PRE-payment problem: Paystack verified a payment for this link that does
   * not match it (amount, currency, test vs live) and it was NOT recorded.
   * Cleared by the paid transition.
   */
  attention?: string | null;
  /**
   * Invoice-step problem after the link was paid: the invoice changed, was
   * voided, or was already paid another way. Written with `invoiceSettledAt`.
   */
  invoiceAttention?: string | null;

  createdAt: Timestamp | FieldValue;
  updatedAt: Timestamp | FieldValue;
}
