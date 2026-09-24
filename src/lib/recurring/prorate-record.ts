/**
 * What a billing-day pro-ration stores on the schedule (`recurringInvoices.proration`),
 * and reading it back. The arithmetic is `prorate.ts`; credits are `prorate-credit.ts`.
 */

export interface ProratedPeriod {
  from: Date;
  /** Exclusive; labels show the day before. */
  to: Date;
  days: number;
  cycleDays: number;
  /** Pre-tax amount, in currency units, rounded to cents. */
  taxable: number;
  label: string;
}

export interface ProrationGap extends ProratedPeriod {
  /** The quote doc id the invoice is raised under, fixed at the edit: a retaken claim cannot raise it twice. */
  docId: string;
  state: "pending" | "raising" | "raised";
  claimedAt: Date | null;
  invoiceId: string | null;
  /** The billed period it belongs to. Only that period's PENDING gaps can be cancelled by a later edit. */
  forLastDueAt: Date | null;
  /** The billing day `to` sits on — what a later gap measured from `to` measures its cycle with. */
  toAnchorDay: number;
  /** An operator Task was raised for a failure; later failures only update `lastError`. */
  failureAlerted: boolean;
}

export interface ProrationCredit extends ProratedPeriod {
  /** Goes on the first invoice generated for a cycle due at or after this. */
  appliesToDueAt: Date;
  /** The cycle number that took it; null while owed. */
  cycle: number | null;
  /** The billed period it was computed in. A later edit in that period recomputes it; others stand. */
  forLastDueAt: Date | null;
}

export interface ProrationRecord {
  /** `lastDueAt` of the billed cycle `coveredUntil` belongs to; stale after the next cycle bills. */
  forLastDueAt: Date | null;
  /** Paid through (exclusive) by billed cycles. Raised or raising gaps extend it; pending ones do not. */
  coveredUntil: Date;
  /** The billing day `coveredUntil` sits on, as billed — not today's anchor. */
  coveredAnchorDay: number;
  credits: ProrationCredit[];
  gaps: ProrationGap[];
}

/** A stored `proration` (Timestamps) back as a record (Dates); null if absent or malformed. */
export function readProration(raw: unknown): ProrationRecord | null {
  const r = asObject(raw);
  const coveredUntil = asDate(r?.coveredUntil);
  // Every field below is written by this code; no stored record predates it.
  if (!r || !coveredUntil || typeof r.coveredAnchorDay !== "number") return null;
  const credits = list(r.credits).flatMap((raw): ProrationCredit[] => {
    const c = asObject(raw);
    const p = period(raw);
    const appliesToDueAt = asDate(c?.appliesToDueAt);
    if (!c || !p || !appliesToDueAt) return [];
    return [{ ...p, appliesToDueAt, cycle: typeof c.cycle === "number" ? c.cycle : null, forLastDueAt: asDate(c.forLastDueAt) }];
  });
  const gaps = list(r.gaps).flatMap((raw): ProrationGap[] => {
    const g = asObject(raw);
    const p = period(raw);
    if (!g || !p || typeof g.docId !== "string" || typeof g.toAnchorDay !== "number") return [];
    return [
      {
        ...p,
        docId: g.docId,
        state: g.state === "raising" || g.state === "raised" ? g.state : "pending",
        claimedAt: asDate(g.claimedAt),
        invoiceId: typeof g.invoiceId === "string" ? g.invoiceId : null,
        forLastDueAt: asDate(g.forLastDueAt),
        toAnchorDay: g.toAnchorDay,
        failureAlerted: g.failureAlerted === true,
      },
    ];
  });
  return {
    forLastDueAt: asDate(r.forLastDueAt),
    coveredUntil,
    coveredAnchorDay: r.coveredAnchorDay,
    credits,
    gaps,
  };
}

function period(raw: unknown): ProratedPeriod | null {
  const q = asObject(raw);
  const [from, to] = [asDate(q?.from), asDate(q?.to)];
  if (!q || !from || !to || typeof q.taxable !== "number") return null;
  return { from, to, days: Number(q.days), cycleDays: Number(q.cycleDays), taxable: q.taxable, label: String(q.label ?? "") };
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function asDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  const t = v as { toDate?: () => Date } | null | undefined;
  return typeof t?.toDate === "function" ? t.toDate() : null;
}
