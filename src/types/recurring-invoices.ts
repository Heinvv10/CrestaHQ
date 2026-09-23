import type { FieldValue, Timestamp } from "firebase-admin/firestore";

import type { Cadence } from "@/lib/recurring/cadence";
import type { QuoteDiscount, QuoteLineItem } from "@/types/quotes";

/**
 * A standing instruction to raise an invoice on a cadence.
 *
 * The schedule is its own top-level document rather than a field on an
 * invoice. If the most recent generated invoice doubled as the template,
 * editing history would change the future, and the schedule would have nowhere
 * to live once that invoice was paid. Generated invoices carry
 * `recurringInvoiceId` as a back-reference; nothing reads the other way.
 *
 * Server-only writes (default-deny rules cover it, so no rules deploy), read
 * through the admin API — the same shape `customAgents` uses.
 */
export interface RecurringInvoiceDoc {
  id: string;

  // ── Tenancy ──────────────────────────────────────────────────────
  agencyId: string;
  subAccountId: string;
  createdByUid: string;

  /** Who is billed. */
  contactId: string;
  /** Operator's label, e.g. "Acme retainer". Never shown to the customer. */
  name: string;
  status: RecurringInvoiceStatus;

  // ── The money template ───────────────────────────────────────────
  // Snapshotted onto each generated invoice, exactly as the product catalog
  // snapshots into a line item: editing the template changes future cycles and
  // never an invoice already raised, which is a historical record of what was
  // billed.
  currency: string;
  lineItems: QuoteLineItem[];
  globalDiscount: QuoteDiscount;
  globalTaxPercent: number | null;

  // ── The document template ────────────────────────────────────────
  termsAndNotes: string;
  billedToOrganization: string | null;
  billingAddress: string | null;
  paymentDueDays: number | null;

  // ── Schedule ─────────────────────────────────────────────────────
  cadence: Cadence;
  /** Day of month for month-based cadences, clamped per cycle. Null = weekly. */
  anchorDay: number | null;
  /**
   * IANA zone the billing day is read in. "Bill on the 1st" has to mean the
   * 1st where the business is; the sub-account's zone, else UTC.
   */
  timezone: string;
  startAt: Timestamp | FieldValue;
  /** Absolute instant the next cycle falls due. The sweep compares only this. */
  nextRunAt: Timestamp | FieldValue;
  endMode: RecurringInvoiceEndMode;
  /** With endMode "on_date". */
  endAt: Timestamp | FieldValue | null;
  /** With endMode "after_count". */
  maxCycles: number | null;

  // ── Behaviour ────────────────────────────────────────────────────
  /**
   * Generate a draft and notify instead of sending. Default false: auto-send
   * is the automation being bought. The flag exists because a recurring
   * invoice demands money under the client's brand — get the template wrong
   * and it goes out wrong every cycle — so a nervous operator, or one
   * high-value customer, can keep a human in the loop without losing the
   * schedule.
   */
  reviewFirst: boolean;
  /**
   * Consecutive unpaid cycles before the run raises a Task. Default 2; `0`
   * disables. An unpaid cycle never stops the next being raised — the debt is
   * real, and silently ceasing to bill a slow payer is worse than billing them
   * twice — so this is what separates a dead card quietly accruing four
   * invoices from someone actually looking.
   */
  unpaidEscalationThreshold: number;

  // ── Run state ────────────────────────────────────────────────────
  cyclesGenerated: number;
  lastRunAt: Timestamp | FieldValue | null;
  lastInvoiceId: string | null;
  /**
   * How many invoices this schedule has SENT that remain unpaid, recounted
   * from the invoices themselves each run.
   *
   * Named for what it is. An earlier draft called it `consecutiveUnpaid`,
   * which it never was — cycles 1, 5 and 9 unpaid with everything else
   * settled is three outstanding invoices and no two consecutive misses. The
   * count is the right signal either way; the name was the lie.
   */
  outstandingInvoices: number;
  lastEscalatedAt: Timestamp | FieldValue | null;
  /**
   * The outstanding count the last Task was raised at. Escalation only fires
   * when the situation gets WORSE than this, so a customer stuck at three
   * unpaid invoices produces one Task, not a fresh one every night with its
   * own `task.created` webhooks.
   */
  lastEscalatedCount: number | null;
  /** Why a run could not send, surfaced on the operator's list. */
  lastError: string | null;
  /**
   * The card-on-file mandate most recently authorised for this schedule,
   * written with it by the payment reconciler. Also what serialises two
   * card payments for one schedule. Its status still decides chargeability.
   */
  cardMandateId?: string | null;
  /**
   * How each cycle asks for the money. Absent/"invoice": email the invoice.
   * "card": charge the saved card (`cardMandateId`) instead, and email only
   * when the card cannot be charged or is declined. ZAR only, and never with
   * `reviewFirst` — an unattended charge cannot wait for a review.
   */
  chargeMode?: RecurringChargeMode;
  /**
   * The due date of the last cycle actually billed (any charge mode), written
   * by the claim. A card cycle due sooner than its cadence allows after it is
   * emailed instead of charged — so no edit can charge twice in one period.
   * Absent on schedules last billed before it existed.
   */
  lastDueAt?: Timestamp | FieldValue | null;

  createdAt: Timestamp | FieldValue;
  updatedAt: Timestamp | FieldValue;
}

export type RecurringInvoiceStatus =
  | "active"
  | "paused"
  | "completed"
  | "cancelled";

export type RecurringInvoiceEndMode = "never" | "on_date" | "after_count";

export type RecurringChargeMode = "invoice" | "card";

/** What one schedule's cycle did, for the run summary and the tests. */
export type RecurringCycleOutcome =
  | { kind: "generated"; invoiceId: string; sent: boolean }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; reason: string };

export const RECURRING_INVOICE_DEFAULTS = {
  status: "active" as RecurringInvoiceStatus,
  endMode: "never" as RecurringInvoiceEndMode,
  reviewFirst: false,
  unpaidEscalationThreshold: 2,
  cyclesGenerated: 0,
  outstandingInvoices: 0,
} as const;

/**
 * Statuses meaning the customer was asked for money and it has not arrived.
 *
 * `draft` is deliberately absent: a review-first schedule parks every invoice
 * at `draft` by design, so counting those would have it escalating on its
 * second cycle over money nobody has been asked for.
 */
export const UNPAID_INVOICE_STATUSES = ["sent", "viewed"] as const;
