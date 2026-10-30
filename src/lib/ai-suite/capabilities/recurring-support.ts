import "server-only";

import { isDocId } from "@/lib/server/doc-id";
import { getAdminDb } from "@/lib/firebase/admin";
import { canonical } from "@/lib/server/agent-proposals-encoding";
import { cadenceFrequency, termsStillHold } from "@/lib/server/payment-mandates";
import { computeQuoteTotals, lineItemSubtotal } from "@/lib/quotes/calc";
import type { PaymentMandate } from "@/types/payment-mandates";
import type { RecurringInvoiceDoc } from "@/types/recurring-invoices";
import type { ProrationRecord } from "@/lib/recurring/prorate-record";
import { CapabilityUserError, type PreviewRow } from "./types";
import { fmtMoney, toDate, ymdInTz } from "./helpers";
import { oneLine } from "./text-safety";

/** Shared by the recurring-schedule capabilities (recurring.ts, recurring-edit.ts). */

export const scheduleIdParam = { type: "string", description: "The schedule's id (from list_recurring_schedules)." };

export type Schedule = RecurringInvoiceDoc;
type Get = (ref: FirebaseFirestore.DocumentReference) => Promise<FirebaseFirestore.DocumentSnapshot>;
const plainGet: Get = (ref) => ref.get();

export async function tenantSchedule(subAccountId: string, scheduleId: unknown, get: Get = plainGet): Promise<Schedule> {
  const snap = isDocId(scheduleId) ? await get(getAdminDb().doc(`recurringInvoices/${scheduleId}`)) : null;
  const data = snap?.data();
  if (!data || data.subAccountId !== subAccountId) throw new CapabilityUserError("That recurring schedule isn't in this workspace.");
  return { ...(data as Omit<Schedule, "id">), id: snap!.id };
}

const iso = (v: unknown) => toDate(v)?.toISOString() ?? null;

/** Everything a cycle bills from and every run-state field, for pinning: a
 *  change to any of them since review refuses the write. `withProration:
 *  false` for a planned state, whose new gap invoices get fresh ids each time
 *  (prorationRows shows what it raises). */
export function scheduleState(s: FirebaseFirestore.DocumentData, withProration = true): string {
  return canonical([
    s.status, s.name, s.contactId, s.currency, s.lineItems, s.globalDiscount ?? null, s.globalTaxPercent ?? null,
    s.termsAndNotes ?? "", s.billedToOrganization ?? null, s.billingAddress ?? null, s.paymentDueDays ?? null,
    s.cadence, s.anchorDay ?? null, s.timezone, iso(s.startAt), iso(s.nextRunAt), s.endMode, iso(s.endAt), s.maxCycles ?? null,
    s.reviewFirst === true, s.chargeMode ?? "invoice", s.unpaidEscalationThreshold ?? null, s.cyclesGenerated ?? 0,
    iso(s.lastRunAt), iso(s.lastDueAt), s.cardMandateId ?? null, withProration ? JSON.stringify(s.proration ?? null) : null,
  ]);
}

const amount = (s: Schedule) => fmtMoney(computeQuoteTotals(s).total, s.currency || "USD");

/** Whether the next cycle charges a saved card, in words (read in `get`'s transaction when given). */
export async function cardOutcome(s: Schedule, get: Get = plainGet): Promise<string> {
  if (s.status !== "active") return `No card is charged: the schedule is ${s.status}.`;
  if ((s.chargeMode ?? "invoice") !== "card") return "No card is charged: each invoice is emailed.";
  if (!s.cardMandateId) return "No card is saved yet: the next invoice is emailed with a card-on-file link instead.";
  const m = (await get(getAdminDb().doc(`paymentMandates/${s.cardMandateId}`))).data() as PaymentMandate | undefined;
  if (!m || m.subAccountId !== s.subAccountId || m.recurringInvoiceId !== s.id) return "The saved card can't be used: the invoice is emailed instead.";
  if (m.status !== "active") return `The saved card isn't chargeable (${m.status}): the invoice is emailed instead.`;
  if (!termsStillHold(m.terms, s)) return "The saved card's terms no longer match this schedule's amount or frequency: the invoice is emailed instead.";
  return `The saved card (${s.cardMandateId}) is charged ${amount(s)} on the next cycle, unless Paystack refuses it (then the invoice is emailed).`;
}

const ending = (s: Schedule) =>
  s.endMode === "on_date" ? `on ${iso(s.endAt)?.slice(0, 10) ?? "(no date)"}` : s.endMode === "after_count" ? `after ${s.maxCycles} cycles` : "never";

/** The schedule as an approver reads it; with `before`, each field old -> new. */
export function scheduleRows(after: Schedule, before: Schedule | null): PreviewRow[] {
  const tz = after.timezone || "UTC";
  const lines = (s: Schedule) => (s.lineItems ?? []).map((li) => `${li.quantity} \u00d7 ${oneLine(li.description)} @ ${fmtMoney(li.unitPrice, s.currency)} = ${fmtMoney(lineItemSubtotal(li), s.currency)}`).join("\n") || "(none)";
  const fields: Array<[string, (s: Schedule) => string]> = [
    ["Status", (s) => s.status],
    ["Name", (s) => oneLine(s.name) || "(unnamed)"],
    ["Contact", (s) => s.contactId],
    ["Amount each cycle", (s) => `${amount(s)} (${s.currency})`],
    ["Frequency", (s) => `${cadenceFrequency(s.cadence)}${s.anchorDay ? `, on day ${s.anchorDay}` : ""} (${s.timezone})`],
    ["Next billing", (s) => (s.status === "active" || s.status === "paused" ? (toDate(s.nextRunAt) ? ymdInTz(toDate(s.nextRunAt)!, tz) : "(none)") : "none")],
    ["Ends", ending],
    ["How each cycle asks", (s) => ((s.chargeMode ?? "invoice") === "card" ? "charges the saved card" : "emails the invoice")],
    ["Review each invoice first", (s) => String(s.reviewFirst === true)],
    ["Task after unpaid cycles", (s) => (s.unpaidEscalationThreshold ? String(s.unpaidEscalationThreshold) : "off")],
    ["Terms and notes", (s) => oneLine(s.termsAndNotes) || "(none)"],
    ["Billed to", (s) => [oneLine(s.billedToOrganization), oneLine(s.billingAddress)].filter(Boolean).join(", ") || "(none)"],
    ["Payment due days", (s) => (s.paymentDueDays == null ? "(none)" : String(s.paymentDueDays))],
  ];
  const rows: PreviewRow[] = fields.map(([label, show]) => {
    const [a, b] = [before ? show(before) : null, show(after)];
    return { label, value: a === null ? b : a === b ? `${b} (unchanged)` : `${a} \u2192 ${b}` };
  });
  const [la, lb] = [before ? lines(before) : null, lines(after)];
  if (la !== lb && la !== null) rows.push({ label: "Line items now", value: la, multiline: true });
  rows.push({ label: la === null || la === lb ? "Line items" : "Line items after", value: lb, multiline: true });
  return rows;
}

/** What a billing-day change pro-rates: the gap invoices it raises and the
 *  credits owed on the next invoice (lib/recurring/prorate.ts). */
export function prorationRows(record: ProrationRecord | null | undefined, currency: string): PreviewRow[] {
  if (!record) return [];
  const gaps = record.gaps.filter((g) => g.state === "pending").map((g) => `an invoice for ${oneLine(g.label)}: ${fmtMoney(g.taxable, currency)} before tax`);
  const credits = record.credits.filter((c) => c.cycle === null).map((c) => `a credit for ${oneLine(c.label)}: ${fmtMoney(c.taxable, currency)} before tax, on the next invoice`);
  return gaps.length || credits.length ? [{ label: "Pro-rata", value: [...gaps, ...credits].join("\n"), multiline: true }] : [];
}
