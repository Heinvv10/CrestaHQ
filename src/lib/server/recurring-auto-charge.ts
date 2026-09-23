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
import { termsStillHold } from "@/lib/server/payment-mandates";
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
 *   not chargeable → the invoice is emailed, and the schedule says why;
 *   declined       → recorded on the attempt, invoice and mandate, the invoice
 *                    is emailed (it carries a pay link), `invoice.charge_failed`;
 *   due too soon after the previous cycle (an edit moved it) → emailed; a Task;
 *   key refused    → emailed and a Task; not counted against the card, no trigger;
 *   no clear answer → NOT emailed — the card may have been charged — and a
 *                    Task names the reference to check.
 */

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
    const why = `This cycle is due ${day(due)}, only ${days} days after the previous cycle (${day(prev)}) — usually because the billing day or frequency was changed — so the card was not charged and the invoice was emailed instead.`;
    await note(`Card not charged for invoice ${label}. ${why}`);
    await alert(`Card not charged: invoice ${label} came due too soon after the previous cycle`, why);
    return sendGeneratedInvoice(schedule, invoiceId);
  }
  if (!opened.ok) {
    await note(`Card not charged for invoice ${label}: ${opened.reason} — invoice emailed instead.`);
    return sendGeneratedInvoice(schedule, invoiceId);
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
        `Check reference ${reference} in your Paystack dashboard before billing again — it is recorded here automatically if it went through.`,
    );
    // Once per cycle: this path runs only for the call that created the attempt.
    await alert(
      `Check Paystack: card charge for invoice ${label} has no clear outcome`,
      `The saved-card charge for invoice ${label} (Paystack reference ${reference}) got no clear answer: ${answer.reason}. ` +
        `The invoice was not emailed: check Paystack before sending this invoice — the card may already have been charged. ` +
        `If the charge went through, it is recorded here automatically.`,
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
  if (keyRefused) {
    await note(`Card not charged for invoice ${label}: Paystack refused this workspace's key (${answer.reason}) — invoice emailed instead.`);
    await alert(
      `Paystack refused the key: invoice ${label} was not charged`,
      `Charging the saved card for invoice ${label} (Paystack reference ${reference}) failed because Paystack refused this workspace's key: ${answer.reason}. ` +
        `The invoice was emailed instead. Check the Paystack connection before the next cycle.`,
    );
  } else {
    await countDecline(opened.mandateId, answer.reason, schedule.unpaidEscalationThreshold).catch((err: unknown) =>
      console.error(`${tag} decline not counted on the mandate`, err),
    );
    await note(`Card declined for invoice ${label} (${answer.reason}) — invoice emailed with a payment link instead.`);
  }
  const sent = await sendGeneratedInvoice(schedule, invoiceId);
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
  const previousDueAt = toDate(schedule.lastDueAt); // pre-claim: the PREVIOUS cycle's; absent (billed before the field existed) = unguarded
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
    const amountCents = invoice ? invoiceTotalCents(invoice) : NaN;
    if (
      !invoice ||
      (invoice.currency || "").toUpperCase() !== mandate.terms.currency ||
      amountCents !== mandate.terms.amountCents ||
      !termsStillHold(mandate.terms, schedule)
    ) {
      return no("the invoice no longer matches the amount the customer authorised");
    }
    if (previousDueAt && dueAt.getTime() - previousDueAt.getTime() < minCardChargeGapMs(schedule.cadence)) {
      return { ok: false, tooSoon: { dueAt, previousDueAt } };
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

/** One more decline in a row; at the schedule's threshold the card needs attention. */
async function countDecline(mandateId: string, reason: string, threshold: number): Promise<void> {
  const db = getAdminDb();
  const ref = db.doc(`paymentMandates/${mandateId}`);
  await db.runTransaction(async (t) => {
    const mandate = (await t.get(ref)).data() as PaymentMandate | undefined;
    if (!mandate) return;
    const declines = (mandate.consecutiveDeclines ?? 0) + 1;
    const escalate = threshold > 0 && declines >= threshold && mandate.status === "active";
    t.update(ref, {
      consecutiveDeclines: declines,
      lastDeclineReason: reason,
      ...(escalate
        ? {
            status: "attention",
            attention: `Declined ${declines} times in a row (last: ${reason}). Invoices are emailed instead until the customer saves a new card.`,
          }
        : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });
}
