import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { usageRebillingState } from "@/lib/server/usage-meter";
import { createUsageCharge } from "@/lib/server/billing-service";
import { billingRecipient } from "@/lib/server/usage-billing-recipient";
import { sendUsageEmail } from "@/lib/server/usage-billing-email";
import {
  DAY_MS,
  inPool,
  PENDING_COLLECTION,
  toMillis,
  type PendingChargeDoc,
  type UsageClosedSnapshot,
} from "@/lib/server/usage-billing-shared";
import {
  formatUsageMonth,
  localDay,
  USAGE_PAYMENT_TERMS_DAYS,
  USAGE_REMINDER_DAYS_BEFORE,
} from "@/lib/billing/usage";
import type { UsageChargeLine } from "@/types/billing";
import type { SubAccountDoc } from "@/types";

/** A charge older than this stops retrying its invoice email (reminders take over). */
const INVOICE_EMAIL_RETRY_DAYS = 7;
/** A claim this old with no send recorded belongs to a run that died; take it over. */
const CLAIM_TIMEOUT_MS = 15 * 60 * 1000;

/** Mint queued charges and email each once; entries stay queued until both are done. */
export async function processPendingCharges(now: Date): Promise<{ charged: number; failed: number }> {
  const db = getAdminDb();
  // Normally a handful of entries; read them all so none waits behind others.
  const queue = await db.collection(PENDING_COLLECTION).get();
  let charged = 0;
  const failed = await inPool(queue.docs, async (q) => {
    const p = q.data() as PendingChargeDoc;
    const ledgerRef = db.doc(`subAccounts/${p.subAccountId}/usage/${p.month}`);
    const [subSnap, ledger] = await Promise.all([db.doc(`subAccounts/${p.subAccountId}`).get(), ledgerRef.get()]);
    const frozen = (ledger.data() as { closed?: UsageClosedSnapshot } | undefined)?.closed;
    if (!subSnap.exists || !frozen?.chargeId || frozen.skipped || frozen.chargeId !== q.id) {
      await q.ref.delete();
      return;
    }
    const sub = { ...(subSnap.data() as SubAccountDoc), id: subSnap.id };

    // Fail closed: a switch turned off since the freeze means nothing is minted.
    if (!(await usageRebillingState(sub)).active) {
      console.warn(`[usage-close] charge withheld, rebilling switched off sa=${sub.id} month=${p.month}`);
      await ledgerRef.update({ "closed.withheldAt": FieldValue.serverTimestamp() });
      await q.ref.delete();
      return;
    }

    const to = await billingRecipient(sub);
    // The due date counts from when the charge is actually created.
    const dueAt = new Date(now.getTime() + USAGE_PAYMENT_TERMS_DAYS * DAY_MS);
    // A Paystack refusal for want of an email throws here and the entry stays
    // queued, so it is logged every day until the contact is set.
    const created = await createUsageCharge({
      agencyId: sub.agencyId,
      subAccountId: sub.id,
      month: p.month,
      description: `Usage — ${formatUsageMonth(p.month)}`,
      amountCents: frozen.totalCents,
      currency: frozen.currency,
      lineItems: frozen.lineItems,
      dueAt,
      payerEmail: to,
    });
    if (created.created) charged++;

    const chargeRef = db.doc(`billingCharges/${frozen.chargeId}`);
    // Claim the invoice email so overlapping runs can't both send it.
    // "done" drops the queue entry; "busy" leaves it for the run holding the claim.
    const claim = await db.runTransaction(async (tx) => {
      const c = (await tx.get(chargeRef)).data();
      if (!c || c.status !== "pending" || c.emailedTo) return { state: "done" as const };
      // Counted from the charge, so a charge created late still gets its email.
      const createdMs = toMillis(c.createdAt) ?? now.getTime();
      if (now.getTime() - createdMs > INVOICE_EMAIL_RETRY_DAYS * DAY_MS) return { state: "done" as const };
      const claimedMs = toMillis(c.invoiceEmailClaimedAt);
      if (claimedMs !== null && now.getTime() - claimedMs < CLAIM_TIMEOUT_MS) return { state: "busy" as const };
      tx.update(chargeRef, { invoiceEmailClaimedAt: FieldValue.serverTimestamp() });
      return { state: "claimed" as const, c };
    });
    if (claim.state === "busy") return;
    if (claim.state === "done") {
      await q.ref.delete();
      return;
    }
    if (!to) {
      console.warn(`[usage-close] no invoice recipient sa=${sub.id} month=${p.month}; charge ${frozen.chargeId} not emailed`);
      await chargeRef.update({ invoiceEmailClaimedAt: FieldValue.delete() });
      await q.ref.delete();
      return;
    }
    const c = claim.c;
    const sent = await sendUsageEmail({
      kind: "invoice",
      to,
      sub,
      month: p.month,
      amountCents: Number(c.amountCents ?? frozen.totalCents),
      currency: String(c.currency ?? frozen.currency),
      lineItems: (c.lineItems as UsageChargeLine[] | undefined) ?? frozen.lineItems,
      payUrl: String(c.payUrl ?? ""),
      dueAt: new Date(toMillis(c.dueAt) ?? dueAt.getTime()),
    });
    if (sent) {
      await chargeRef.update({ emailedTo: to, updatedAt: FieldValue.serverTimestamp() });
      await q.ref.delete();
    } else {
      // Release the claim so tomorrow's run tries again.
      await chargeRef.update({ invoiceEmailClaimedAt: FieldValue.delete() });
    }
  });
  return { charged, failed };
}

/** Reminders by local calendar day. Dates are checked in memory. */
export async function sendDueReminders(now: Date): Promise<{ sent: number; failed: number }> {
  const db = getAdminDb();
  const pending = await db
    .collection("billingCharges")
    .where("kind", "==", "usage")
    .where("status", "==", "pending")
    .get();
  const today = localDay(now.getTime());
  let sent = 0;
  const failed = await inPool(pending.docs, async (doc) => {
    const data = doc.data();
    const dueMs = toMillis(data.dueAt);
    if (dueMs === null || !data.payUrl) return;
    const dueDay = localDay(dueMs);
    const warnDay = localDay(dueMs - USAGE_REMINDER_DAYS_BEFORE * DAY_MS);
    // Each stage has its own stamp, so "due today" doesn't suppress the overdue notice.
    const stage: "beforeDue" | "onDue" | "overdue" | null =
      today > dueDay ? "overdue" : today === dueDay ? "onDue" : today >= warnDay ? "beforeDue" : null;
    if (!stage) return;
    // Claim the stamp first so overlapping runs can't both send. A failed send
    // isn't retried; the next stage follows.
    const claimed = await db.runTransaction(async (tx) => {
      const d = (await tx.get(doc.ref)).data();
      if (!d || d.status !== "pending" || d.remindedAt?.[stage]) return false;
      tx.update(doc.ref, { [`remindedAt.${stage}`]: FieldValue.serverTimestamp() });
      return true;
    });
    if (!claimed) return;
    const subSnap = await db.doc(`subAccounts/${data.subAccountId}`).get();
    if (!subSnap.exists) return;
    const sub = { ...(subSnap.data() as SubAccountDoc), id: subSnap.id };
    const to = await billingRecipient(sub);
    if (!to) return;
    const ok = await sendUsageEmail({
      kind: stage,
      to,
      sub,
      month: String(data.usageMonth ?? ""),
      amountCents: Number(data.amountCents ?? 0),
      currency: String(data.currency ?? "usd"),
      lineItems: (data.lineItems as UsageChargeLine[] | undefined) ?? [],
      payUrl: String(data.payUrl),
      dueAt: new Date(dueMs),
    });
    if (ok) sent++;
  });
  return { sent, failed };
}
