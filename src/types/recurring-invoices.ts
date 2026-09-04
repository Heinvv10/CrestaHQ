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
  /** Recounted each run from the schedule's own generated invoices. */
  consecutiveUnpaid: number;
  lastEscalatedAt: Timestamp | FieldValue | null;
  /** Why a run could not send, surfaced on the operator's list. */
  lastError: string | null;

  createdAt: Timestamp | FieldValue;
  updatedAt: Timestamp | FieldValue;
}

export type RecurringInvoiceStatus =
  | "active"
  | "paused"
  | "completed"
  | "cancelled";

export type RecurringInvoiceEndMode = "never" | "on_date" | "after_count";

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
  consecutiveUnpaid: 0,
} as const;

/** Invoice statuses that mean the money has NOT arrived. */
export const UNPAID_INVOICE_STATUSES = [
  "draft",
  "sent",
  "viewed",
] as const;
