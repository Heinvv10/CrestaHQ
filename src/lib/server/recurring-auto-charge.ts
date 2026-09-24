import "server-only";

import { FieldValue } from "firebase-admin/firestore";

import { BillingError } from "@/lib/billing/errors";
import { getAdminDb } from "@/lib/firebase/admin";
import { chargePaystackAuthorization } from "@/lib/paystack/billing-api";
import { paystackKeyFingerprint } from "@/lib/paystack/key-fingerprint";
import { readPaystackConnectionSecret } from "@/lib/paystack/sub-account-client";
import { minCardChargeGapMs } from "@/lib/recurring/charge-gap";
import { invoiceTotalCents } from "@/lib/server/payment-links-service";
import { raiseChargeTask } from "@/lib/server/auto-charge-alerts";
import { countDecline, termsStillHold } from "@/lib/server/payment-mandates";
import { schedulesCollection, sendGeneratedInvoice, toDate } from "@/lib/server/recurring-invoice-cycle";
import { fireWorkflowTrigger } from "@/lib/workflows/engine";
import type { PaymentAttempt } from "@/types/payment-attempts";
import { paymentMandateSecretPath, type PaymentMandate, type PaymentMandateSecret } from "@/types/payment-mandates";
import type { Quote, QuoteAutoCharge } from "@/types/quotes";
import type { RecurringInvoiceDoc } from "@/types/recurring-invoices";

/**
 * A `chargeMode: "card"` cycle: charge the schedule's saved card for the
 * invoice just raised, instead of emailing it.
 *
 * One attempt per cycle, no retries (W5 ruling 3). The attempt's reference is
 * derived from the schedule and the cycle number the claim wrote, and the
 * attempt doc is CREATED before Paystack is called — so a re-run cycle finds
 * it and charges nothing. Nothing is marked paid here: Paystack's answer to
 * the charge call is not proof, and only the verified webhook
 * (`auto-charge-reconciler.ts`) records a payment.
 *
 *   not chargeable → emailed, and a Task — except a first cycle with no card yet (its email saves one);
 *                    a card-on-file link the email could not carry joins that one Task;
 *   declined       → recorded on the attempt, invoice and mandate, the invoice
 *                    is emailed (it carries a pay link), `invoice.charge_failed`;
 *   due too soon after the previous cycle (an edit moved it) → emailed; a Task;
 *   key refused    → emailed and a Task; not counted against the card, no trigger;
 *   no clear answer → NOT emailed — the card may have been charged — and a
 *                    Task names the reference to check.
 */

const EMAILED = "The invoice was emailed instead.";

export const autoChargeReference = (scheduleId: string, cycle: number) => `ra-${scheduleId}-c${cycle}`;

/** The schedule id of an auto-charge reference, else null. */
export function parseAutoChargeReference(reference: string): string | null {
  return /^ra-([A-Za-z0-9]+)-c[1-9][0-9]*$/.exec(reference)?.[1] ?? null;
}

export async function fireChargeTrigger(
  q: Pick<Quote, "agencyId" | "subAccountId" | "contactId">,
  type: "invoice.charge_succeeded" | "invoice.charge_failed",
): Promise<void> {
  await fireWorkflowTrigger({ agencyId: q.agencyId, subAccountId: q.subAccountId, type, contactId: q.contactId });
}

type Opened =
  | { ok: true; secretKey: string; secret: PaymentMandateSecret; mandateId: string; amountCents: number; currency: string }
  | { ok: false; reason: string }
  | { ok: false; alreadyCharged: true }
  | { ok: false; tooSoon: { dueAt: Date; previousDueAt: Date } };

/** Returns whether the invoice was emailed. */
export async function chargeCycle(
  schedule: RecurringInvoiceDoc,
  invoiceId: string,
  cycle: number,
  /** This cycle's due date, from the claim. */
  dueAt: Date,
): Promise<boolean> {
  const db = getAdminDb();
  const reference = autoChargeReference(schedule.id, cycle);
  const invoiceRef = db.doc(`quotes/${invoiceId}`);
  const invoice = (await invoiceRef.get()).data() as Quote | undefined;
  const label = invoice?.quoteNumber || invoiceId;
  const tag = `[recurring/auto-charge] schedule=${schedule.id} ref=${reference}`;
  const note = (lastError: string) =>
    schedulesCollection()
      .doc(schedule.id)
      .update({ lastError: lastError.slice(0, 500), updatedAt: FieldValue.serverTimestamp() })
      .catch((err: unknown) => console.error(`${tag} lastError not written`, err));
  // No redelivery re-runs a cycle, so a Task that fails to create is logged;
  // the `lastError` written beside it still tells the operator.
  const alert = (title: string, notes: string) =>
    raiseChargeTask(schedule, title, notes).catch((err: unknown) => console.error(`${tag} task not raised: ${title}`, err));
  type TaskText = { title: string; notes: string };
  // "emailed" only once sent. ONE Task carries every reason; a failed send always raises one.
  const emailInstead = async (why: string, task?: TaskText) => {
    await note(why);
    let res: Awaited<ReturnType<typeof sendGeneratedInvoice>> | undefined;
    try {
      res = await sendGeneratedInvoice(schedule, invoiceId, why);
      if (res.sent) await note([why, EMAILED, res.cardLinkFallback].filter(Boolean).join(" "));
      return res.sent;
    } finally {
      const failure = res?.sent ? null : (res?.error ?? "the send failed unexpectedly");
      const extra = [failure ? `Invoice not sent: ${failure}` : EMAILED, res?.cardLinkFallback].filter(Boolean).join(" ");
      if (task) await alert(task.title, `${task.notes} ${extra}`.trim());
      else if (failure) await alert(`Invoice ${label} was not sent: ${failure}`, `${why} ${extra}`);
      else if (res?.cardLinkFallback) await alert(res.cardLinkFallback, "Until a card is saved, each cycle emails its invoice instead of charging a card.");
    }
  };

  const opened = await openAttempt(schedule, invoiceId, invoice, reference, dueAt);
  if ("alreadyCharged" in opened) {
    console.error(`${tag} cycle already has a charge attempt; not charging again`);
    await note(`Card not charged for invoice ${label}: cycle ${cycle} was already charged (Paystack reference ${reference}). Check for a duplicate invoice.`);
    return false;
  }
  if ("tooSoon" in opened) {
    const day = new Intl.DateTimeFormat("en-GB", { timeZone: schedule.timezone, dateStyle: "long" }).format;
    const { dueAt: due, previousDueAt: prev } = opened.tooSoon;
    const days = Math.round((due.getTime() - prev.getTime()) / 86_400_000);
    const why = `This cycle is due ${day(due)}, only ${days} days after the previous cycle (${day(prev)}) — usually because the billing day or frequency was changed — so the card was not charged.`;
    const title = `Card not charged: invoice ${label} came due too soon after the previous cycle`;
    return emailInstead(`Card not charged for invoice ${label}. ${why}`, { title, notes: why });
  }
  if (!opened.ok) {
    // Except the expected start: a first cycle with no card yet, whose email carries the card-on-file link.
    const expected = !schedule.cardMandateId && cycle === 1;
    const task = { title: `Card not charged for invoice ${label}: ${opened.reason}`, notes: "" };
    return emailInstead(`Card not charged for invoice ${label}: ${opened.reason}.`, expected ? undefined : task);
  }

  const setInvoice = (autoCharge: QuoteAutoCharge) =>
    invoiceRef
      .update({ autoCharge, updatedAt: FieldValue.serverTimestamp() })
      .catch((err: unknown) => console.error(`${tag} invoice autoCharge not written`, err));
  const base = { reference, mandateId: opened.mandateId };

  const answer = await charge(opened, reference);
  if (answer.kind === "accepted") {
    await setInvoice({ ...base, state: "pending", reason: null });
    return false;
  }
  if (answer.kind === "unknown") {
    console.error(`${tag} no clear answer from Paystack: ${answer.reason}`);
    await setInvoice({ ...base, state: "unknown", reason: answer.reason });
    await note(
      `Card charge for invoice ${label} got no clear answer from Paystack (${answer.reason}). ` +
        `Paystack reference ${reference}: use "Re-check card charge" on the invoice before billing again — it is recorded here automatically if it went through.`,
    );
    // Once per cycle: this path runs only for the call that created the attempt.
    await alert(
      `Check Paystack: card charge for invoice ${label} has no clear outcome`,
      `The saved-card charge for invoice ${label} (Paystack reference ${reference}) got no clear answer: ${answer.reason}. ` +
        `The invoice was not emailed — the card may already have been charged. Use "Re-check card charge" on the invoice: it asks Paystack and records a payment, or a decline so the invoice can be sent. ` +
        `Do not send a pay link: it would charge the customer twice.`,
    );
    return false;
  }

  // Declined, or Paystack refused this workspace's key: no money was taken
  // on this reference. A refused key says nothing about the card, so it is
  // not counted against the mandate — the operator has a connection to fix.
  const keyRefused = answer.kind === "key";
  await refuseAttempt(reference, `${keyRefused ? "Paystack refused the key" : "Card declined"}: ${answer.reason}`).catch(
    (err: unknown) => console.error(`${tag} attempt not refused`, err),
  );
  await setInvoice({ ...base, state: "declined", reason: answer.reason });
  let chargeNote = `Card declined for invoice ${label} (${answer.reason}).`;
  let task: TaskText | undefined;
  if (keyRefused) {
    chargeNote = `Card not charged for invoice ${label}: Paystack refused this workspace's key (${answer.reason}).`;
    task = {
      title: `Paystack refused the key: invoice ${label} was not charged`,
      notes:
        `Charging the saved card for invoice ${label} (Paystack reference ${reference}) failed because Paystack refused this workspace's key: ${answer.reason}. ` +
        `Check the Paystack connection before the next cycle.`,
    };
  } else {
    await countDecline(opened.mandateId, answer.reason, schedule.unpaidEscalationThreshold).catch((err: unknown) =>
      console.error(`${tag} decline not counted on the mandate`, err),
    );
  }
  const sent = await emailInstead(chargeNote, task);
  // A refused key is the workspace's problem; the customer's card did not fail.
  if (!keyRefused) await fireChargeTrigger(schedule, "invoice.charge_failed");
  return sent;
}

/**
 * Decide chargeability and record the attempt in ONE transaction that reads
 * the connection: a key switch or revoke landing first retries it and is
 * seen; one landing after finds this attempt open and flags it.
 * `cardMandateId` is only a pointer — the mandate's own status decides.
 *
 * Also where "never twice in one period" is enforced, on cycle DUE DATES —
 * this one vs `lastDueAt`, however that cycle was paid (card, link, by hand).
 * Late sweeps and pauses move neither; only a billing-day/frequency edit can.
 */
async function openAttempt(
  schedule: RecurringInvoiceDoc,
  invoiceId: string,
  invoice: Quote | undefined,
  reference: string,
  dueAt: Date,
): Promise<Opened> {
  const db = getAdminDb();
  const attemptRef = db.doc(`paymentAttempts/${reference}`);
  // Pre-claim: the PREVIOUS cycle's due date. A schedule last billed before `lastDueAt` existed falls back to `lastRunAt` (≥ that due date, so it errs toward emailing).
  const previousDueAt = toDate(schedule.lastDueAt) ?? toDate(schedule.lastRunAt);
  return db.runTransaction(async (t): Promise<Opened> => {
    if ((await t.get(attemptRef)).exists) return { ok: false, alreadyCharged: true };
    const no = (reason: string) => ({ ok: false as const, reason });
    const mandateId = schedule.cardMandateId;
    if (!mandateId) return no("no card is saved for this schedule");
    const mandate = (await t.get(db.doc(`paymentMandates/${mandateId}`))).data() as PaymentMandate | undefined;
    const conn = await readPaystackConnectionSecret(schedule.subAccountId, t);
    const secret = (await t.get(db.doc(paymentMandateSecretPath(mandateId)))).data() as PaymentMandateSecret | undefined;
    if (!mandate || mandate.subAccountId !== schedule.subAccountId || mandate.recurringInvoiceId !== schedule.id) {
      return no("the saved card could not be found");
    }
    if (mandate.status === "revoked") return no("the saved card was removed");
    if (mandate.status !== "active") return no(`the saved card needs attention (${mandate.attention ?? "see the contact's saved card"})`);
    if (!conn) return no("Paystack is not connected");
    if (paystackKeyFingerprint(conn.secretKey) !== mandate.keyFingerprint) {
      return no("the Paystack key changed since the card was saved");
    }
    if (!secret) return no("the saved card's authorization is missing");
    // Before the amount check: a billing-day change both moves the cycle and
    // pro-rates its invoice, and the operator is told the cause, not the symptom.
    if (previousDueAt && dueAt.getTime() - previousDueAt.getTime() < minCardChargeGapMs(schedule.cadence)) {
      return { ok: false, tooSoon: { dueAt, previousDueAt } };
    }
    const amountCents = invoice ? invoiceTotalCents(invoice) : NaN;
    if (
      !invoice ||
      (invoice.currency || "").toUpperCase() !== mandate.terms.currency ||
      amountCents !== mandate.terms.amountCents ||
      !termsStillHold(mandate.terms, schedule)
    ) {
      return no("the invoice no longer matches the amount the customer authorised");
    }
    const attempt: Omit<PaymentAttempt, "id"> = {
      agencyId: schedule.agencyId,
      subAccountId: schedule.subAccountId,
      createdByUid: schedule.createdByUid,
      paymentLinkId: null,
      mandateId,
      invoiceId,
      recurringInvoiceId: schedule.id,
      amountCents,
      currency: mandate.terms.currency,
      mode: mandate.mode,
      keyFingerprint: mandate.keyFingerprint,
      state: "open",
      reason: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    t.create(attemptRef, attempt);
    return { ok: true, secretKey: conn.secretKey, secret, mandateId, amountCents, currency: attempt.currency };
  });
}

type Answer = { kind: "accepted" } | { kind: "declined" | "unknown" | "key"; reason: string };

/**
 * Paystack's answer, sorted by what it proves. Only `success` is accepted —
 * still pending until the webhook records it. `failed` or a 4xx refusal is a
 * definite "no money taken"; a 401/403 is our key refused, not the card. A
 * 429, a timeout, a 5xx, no answer, a duplicate-reference refusal (an earlier
 * call may have charged), or any other status is unknown.
 */
async function charge(opened: Extract<Opened, { ok: true }>, reference: string): Promise<Answer> {
  try {
    const res = await chargePaystackAuthorization({
      authorizationCode: opened.secret.authorizationCode,
      email: opened.secret.email,
      amountCents: opened.amountCents,
      currency: opened.currency,
      reference,
      secretKey: opened.secretKey,
    });
    if (res.status === "success") return { kind: "accepted" };
    if (res.status === "failed") {
      return { kind: "declined", reason: res.gateway_response || res.message || "declined by the bank" };
    }
    // pending, send_otp, open_url, …: nobody is present to complete it, and
    // it may yet settle. Not a decline, not a payment.
    return { kind: "unknown", reason: `Paystack answered "${res.status}"${res.gateway_response ? ` (${res.gateway_response})` : ""}` };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const status = err instanceof BillingError ? err.providerStatus : undefined;
    if (status === 401 || status === 403) return { kind: "key", reason };
    const refused =
      status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429 && !/duplicate/i.test(reason);
    return { kind: refused ? "declined" : "unknown", reason };
  }
}

async function refuseAttempt(reference: string, reason: string): Promise<void> {
  const db = getAdminDb();
  const ref = db.doc(`paymentAttempts/${reference}`);
  await db.runTransaction(async (t) => {
    // Only open → refused: never over a settle or a flag.
    if ((await t.get(ref)).data()?.state !== "open") return;
    t.update(ref, { state: "refused", reason, updatedAt: FieldValue.serverTimestamp() });
  });
}
