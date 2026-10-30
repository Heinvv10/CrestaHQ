import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { usageRebillingState } from "@/lib/server/usage-meter";
import { createUsageCharge, mintChargeCheckoutLink } from "@/lib/server/billing-service";
import { recordBillingEvent } from "@/lib/server/billing-lifecycle";
import { billingRecipient } from "@/lib/server/usage-billing-recipient";
import { sendUsageEmail } from "@/lib/server/usage-billing-email";
import {
  DAY_MS,
  inPool,
  PENDING_COLLECTION,
  reason,
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

/** A charge older than this stops retrying its invoice email. */
const INVOICE_EMAIL_RETRY_DAYS = 7;
/** A claim this old with no send recorded belongs to a run that died; take it over. */
const CLAIM_TIMEOUT_MS = 15 * 60 * 1000;

type Charge = FirebaseFirestore.DocumentData;
const claimFresh = (c: Charge, now: Date) => {
  const claimedMs = toMillis(c.invoiceEmailClaimedAt);
  return claimedMs !== null && now.getTime() - claimedMs < CLAIM_TIMEOUT_MS;
};

/**
 * A switch is off by the time the charge comes to be minted. Before the
 * invoice email there is no debt, so nothing is billed; after it, the debt
 * stands. Returns "withheld" (queue entry can go), "stands" (carry on as
 * normal) or "busy" (an email is being sent right now; leave it).
 */
async function withholdUnsent(input: {
  sub: SubAccountDoc;
  month: string;
  chargeId: string;
  now: Date;
  ledgerRef: FirebaseFirestore.DocumentReference;
}): Promise<"withheld" | "stands" | "busy"> {
  const { sub, month, chargeId, now, ledgerRef } = input;
  const chargeRef = getAdminDb().doc(`billingCharges/${chargeId}`);
  const verdict = await getAdminDb().runTransaction(async (tx) => {
    const c = (await tx.get(chargeRef)).data();
    if (!c) return "no_charge" as const;
    if (c.status !== "pending" || c.emailedTo) return "stands" as const;
    if (claimFresh(c, now)) return "busy" as const;
    tx.update(chargeRef, { status: "canceled", tokenHash: null, updatedAt: FieldValue.serverTimestamp() });
    return "canceled" as const;
  });
  if (verdict === "stands" || verdict === "busy") return verdict;

  console.warn(`[usage-close] charge withheld, rebilling switched off sa=${sub.id} month=${month} charge=${verdict}`);
  await ledgerRef.update({ "closed.withheldAt": FieldValue.serverTimestamp() });
  if (verdict === "canceled") {
    recordBillingEvent({
      agencyId: sub.agencyId,
      subAccountId: sub.id,
      event: "charge.canceled",
      detail: { chargeId, kind: "usage", usageMonth: month, reason: "rebilling_switched_off_before_invoice" },
    });
  }
  recordBillingEvent({
    agencyId: sub.agencyId,
    subAccountId: sub.id,
    event: "usage.withheld",
    detail: { month, chargeId, chargeCanceled: verdict === "canceled" },
  });
  return "withheld";
}

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
    const chargeId = frozen.chargeId;
    const held = (err: unknown): never => {
      console.error(`[usage-close] charge held sa=${sub.id} month=${p.month}: ${reason(err)}`);
      throw err;
    };

    // Fail closed: a switch turned off since the freeze means nothing is billed
    // unless the invoice already went out.
    if (!(await usageRebillingState(sub)).active) {
      const verdict = await withholdUnsent({ sub, month: p.month, chargeId, now, ledgerRef });
      if (verdict === "withheld") {
        await q.ref.delete();
        return;
      }
      if (verdict === "busy") return;
    }

    const to = await billingRecipient(sub);
    // The due date counts from when the charge is actually created.
    const dueAt = new Date(now.getTime() + USAGE_PAYMENT_TERMS_DAYS * DAY_MS);
    // A refusal (Paystack with no email, an amount over the ceiling) throws and
    // the entry stays queued, so it is logged every day until it is fixed.
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
    }).catch(held);
    if (created.created) charged++;

    const chargeRef = db.doc(`billingCharges/${chargeId}`);
    // Claim the invoice email so overlapping runs can't both send it.
    // "done" drops the queue entry; "busy" leaves it for the run holding the claim.
    const claim = await db.runTransaction(async (tx) => {
      const c = (await tx.get(chargeRef)).data();
      if (!c || c.status !== "pending" || c.emailedTo) return { state: "done" as const };
      // Counted from the charge, so a charge created late still gets its email.
      const createdMs = toMillis(c.createdAt) ?? now.getTime();
      if (now.getTime() - createdMs > INVOICE_EMAIL_RETRY_DAYS * DAY_MS) return { state: "expired" as const };
      if (claimFresh(c, now)) return { state: "busy" as const };
      tx.update(chargeRef, { invoiceEmailClaimedAt: FieldValue.serverTimestamp() });
      return { state: "claimed" as const, c };
    });
    if (claim.state === "busy") return;
    if (claim.state === "expired") {
      console.warn(`[usage-close] invoice for ${chargeId} never emailed in ${INVOICE_EMAIL_RETRY_DAYS} days; resend it from the charge list`);
    }
    if (claim.state !== "claimed") {
      await q.ref.delete();
      return;
    }
    const release = () => chargeRef.update({ invoiceEmailClaimedAt: FieldValue.delete() });
    // Nobody to email (Stripe): the entry stays queued, so a contact set later
    // gets the invoice on the next run.
    if (!to) {
      console.warn(`[usage-close] no invoice recipient sa=${sub.id} month=${p.month}; ${chargeId} stays queued`);
      await release();
      return;
    }
    // The raw pay token is never stored: a fresh one is minted for each email.
    let payUrl: string;
    try {
      payUrl = await mintChargeCheckoutLink({ agencyId: sub.agencyId, chargeId });
      if (!payUrl) throw new Error("NEXT_PUBLIC_APP_URL isn't configured, so no pay link can be built.");
    } catch (err) {
      await release();
      return held(err);
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
      payUrl,
      dueAt: new Date(toMillis(c.dueAt) ?? dueAt.getTime()),
    });
    if (!sent) {
      // Release the claim so tomorrow's run tries again.
      await release();
      return;
    }
    // At-least-once: if this write (or the delete after it) fails, the entry
    // stays queued and the invoice is sent again once the claim times out.
    await chargeRef.update({ emailedTo: to, updatedAt: FieldValue.serverTimestamp() });
    await q.ref.delete();
  });
  return { charged, failed };
}

/**
 * Reminders by local calendar day, for charges whose invoice was emailed and
 * that are still pending (a cancelled or never-emailed charge is skipped).
 */
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
    if (dueMs === null || !data.emailedTo) return;
    const dueDay = localDay(dueMs);
    const warnDay = localDay(dueMs - USAGE_REMINDER_DAYS_BEFORE * DAY_MS);
    // Each stage has its own stamp, so "due today" doesn't suppress the overdue notice.
    const stage: "beforeDue" | "onDue" | "overdue" | null =
      today > dueDay ? "overdue" : today === dueDay ? "onDue" : today >= warnDay ? "beforeDue" : null;
    if (!stage || data.remindedAt?.[stage]) return;
    // Resolve the recipient BEFORE taking the stamp, so a workspace with
    // nobody to email does not use up the stage.
    const subSnap = await db.doc(`subAccounts/${data.subAccountId}`).get();
    if (!subSnap.exists) return;
    const sub = { ...(subSnap.data() as SubAccountDoc), id: subSnap.id };
    const to = await billingRecipient(sub);
    if (!to) return;
    // Claim the stamp first so overlapping runs can't both send.
    const claimed = await db.runTransaction(async (tx) => {
      const d = (await tx.get(doc.ref)).data();
      if (!d || d.status !== "pending" || d.remindedAt?.[stage]) return false;
      tx.update(doc.ref, { [`remindedAt.${stage}`]: FieldValue.serverTimestamp() });
      return true;
    });
    if (!claimed) return;
    const release = () => doc.ref.update({ [`remindedAt.${stage}`]: FieldValue.delete() });
    // A reminder carries a freshly minted link (the raw token is never stored),
    // which retires the link in the earlier email.
    let payUrl: string;
    try {
      payUrl = await mintChargeCheckoutLink({ agencyId: String(data.agencyId), chargeId: doc.id });
      if (!payUrl) throw new Error("NEXT_PUBLIC_APP_URL isn't configured, so no pay link can be built.");
    } catch (err) {
      await release();
      throw err;
    }
    const ok = await sendUsageEmail({
      kind: stage,
      to,
      sub,
      month: String(data.usageMonth ?? ""),
      amountCents: Number(data.amountCents ?? 0),
      currency: String(data.currency ?? "usd"),
      lineItems: (data.lineItems as UsageChargeLine[] | undefined) ?? [],
      payUrl,
      dueAt: new Date(dueMs),
    });
    if (ok) sent++;
    // The link was already replaced, so a failed send gives the stage back
    // rather than leaving the client with a dead link and no reminder.
    else await release();
  });
  return { sent, failed };
}
