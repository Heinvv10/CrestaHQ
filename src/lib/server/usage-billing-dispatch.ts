import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import {
  BillingError,
  commitChargeLink,
  createUsageCharge,
  MAX_PRICE_CENTS,
  stageChargeLink,
} from "@/lib/server/billing-service";
import { recordBillingEvent } from "@/lib/server/billing-lifecycle";
import { billingRecipient } from "@/lib/server/usage-billing-recipient";
import { resolveUsageSender, sendUsageEmail } from "@/lib/server/usage-billing-email";
import {
  DAY_MS,
  inPool,
  PENDING_COLLECTION,
  toMillis,
  unbillableReason,
  UsageChargeRefused,
  type PendingChargeDoc,
  type UsageClosedSnapshot,
  type UsageRefusal,
} from "@/lib/server/usage-billing-shared";
import { formatUsageMonth, USAGE_PAYMENT_TERMS_DAYS } from "@/lib/billing/usage";
import type { UsageChargeLine } from "@/types/billing";
import type { SubAccountDoc } from "@/types";

/** A charge older than this stops retrying its invoice email, and is cancelled if none went out. */
const INVOICE_EMAIL_RETRY_DAYS = 7;
/** A claim this old with no send recorded belongs to a run that died; take it over. */
const CLAIM_TIMEOUT_MS = 15 * 60 * 1000;

type Charge = FirebaseFirestore.DocumentData;
const claimFresh = (c: Charge, now: Date) => {
  const claimedMs = toMillis(c.invoiceEmailClaimedAt);
  return claimedMs !== null && now.getTime() - claimedMs < CLAIM_TIMEOUT_MS;
};

/**
 * The month is not billed: stamp the ledger and audit it (and the cancel, when
 * a charge was). The amount carried INTO this month stays owed: it is put back
 * on the ledger as `carryOutCents`, so the next billed month (within the
 * 2-month rule) picks it up. The month's own usage is the part that is dropped.
 */
async function recordWithheld(input: {
  sub: SubAccountDoc;
  month: string;
  chargeId: string;
  ledgerRef: FirebaseFirestore.DocumentReference;
  charge: "none" | "canceled";
  why: string;
  carryBackCents: number;
}): Promise<void> {
  const { sub, month, chargeId, ledgerRef, charge, why, carryBackCents } = input;
  console.warn(`[usage-close] month withheld sa=${sub.id} month=${month} charge=${charge}: ${why}`);
  await ledgerRef.update({
    "closed.withheldAt": FieldValue.serverTimestamp(),
    "closed.withheldReason": why,
    "closed.carryOutCents": carryBackCents,
  });
  if (charge === "canceled") {
    recordBillingEvent({
      agencyId: sub.agencyId,
      subAccountId: sub.id,
      event: "charge.canceled",
      detail: { chargeId, kind: "usage", usageMonth: month, reason: why },
    });
  }
  recordBillingEvent({
    agencyId: sub.agencyId,
    subAccountId: sub.id,
    event: "usage.withheld",
    detail: { month, chargeId, chargeCanceled: charge === "canceled", reason: why, carryBackCents },
  });
}

/**
 * The month is no longer eligible by the time the charge comes to be minted.
 * Before the invoice email there is no debt, so nothing is billed; after it, the
 * debt stands. A send that was ATTEMPTED (`emailAttemptedAt`) may have gone out,
 * so it counts as sent. Returns "withheld" (queue entry can go), "stands" (carry
 * on as normal) or "busy" (an email is being sent right now; leave it).
 */
async function withholdUnsent(input: {
  sub: SubAccountDoc;
  month: string;
  chargeId: string;
  now: Date;
  ledgerRef: FirebaseFirestore.DocumentReference;
  carryBackCents: number;
}): Promise<"withheld" | "stands" | "busy"> {
  const { sub, month, chargeId, now, ledgerRef, carryBackCents } = input;
  const chargeRef = getAdminDb().doc(`billingCharges/${chargeId}`);
  const verdict = await getAdminDb().runTransaction(async (tx) => {
    const c = (await tx.get(chargeRef)).data();
    if (!c) return "none" as const;
    if (c.status !== "pending" || c.emailedTo || c.emailAttemptedAt) return "stands" as const;
    if (claimFresh(c, now)) return "busy" as const;
    tx.update(chargeRef, { status: "canceled", tokenHash: null, updatedAt: FieldValue.serverTimestamp() });
    return "canceled" as const;
  });
  if (verdict === "stands" || verdict === "busy") return verdict;
  await recordWithheld({
    sub, month, chargeId, ledgerRef, charge: verdict, why: "rebilling_switched_off_before_invoice", carryBackCents,
  });
  return "withheld";
}

/** Mint queued charges and email each once; entries stay queued until both are done. */
export async function processPendingCharges(
  now: Date,
): Promise<{ charged: number; failed: number; refusals: UsageRefusal[] }> {
  const db = getAdminDb();
  // Normally a handful of entries; read them all so none waits behind others.
  const queue = await db.collection(PENDING_COLLECTION).get();
  let charged = 0;
  const { failed, refusals } = await inPool(queue.docs, async (q) => {
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
    // A BillingError is the service refusing (nothing a retry fixes); anything
    // else is unexpected and stays a failure.
    const refuse = (why: string): never => {
      throw new UsageChargeRefused(sub.id, p.month, why);
    };
    const held = (err: unknown): never => {
      throw err instanceof BillingError ? new UsageChargeRefused(sub.id, p.month, err.message) : err;
    };
    // Checked before any path is built from it.
    if (!sub.agencyId) return refuse("the sub-account has no agency");

    // Fail closed: the full eligibility rule (both switches AND `since` at or
    // before the month's start, as at the freeze) is applied again to the
    // stored docs. A client toggled off and on since the freeze fails it.
    // Nothing is billed unless the invoice already went out.
    const agencyDoc = (await db.doc(`agencies/${sub.agencyId}`).get()).data();
    if (unbillableReason(agencyDoc, sub as unknown as Record<string, unknown>, p.month)) {
      const verdict = await withholdUnsent({
        sub, month: p.month, chargeId, now, ledgerRef, carryBackCents: frozen.carriedInCents ?? 0,
      });
      if (verdict === "withheld") {
        await q.ref.delete();
        return;
      }
      if (verdict === "busy") return;
    }

    // An amount over the ceiling can never be created as a charge. It is held
    // (reported daily) for the retry window, then withheld rather than repeated forever.
    if (frozen.totalCents > MAX_PRICE_CENTS) {
      const queuedMs = toMillis(p.createdAt) ?? now.getTime();
      if (now.getTime() - queuedMs > INVOICE_EMAIL_RETRY_DAYS * DAY_MS) {
        const why = "over ceiling";
        await recordWithheld({
          sub, month: p.month, chargeId, ledgerRef, charge: "none", why, carryBackCents: frozen.carriedInCents ?? 0,
        });
        await q.ref.delete();
        return refuse(`${why}: ${frozen.totalCents} exceeds ${MAX_PRICE_CENTS} minor units for ${INVOICE_EMAIL_RETRY_DAYS} days; the month was withheld`);
      }
    }

    const to = await billingRecipient(sub);
    // The due date counts from when the charge is actually created.
    const dueAt = new Date(now.getTime() + USAGE_PAYMENT_TERMS_DAYS * DAY_MS);
    // A refusal (Paystack with no email, an amount over the ceiling) throws and
    // the entry stays queued, so it is reported every day until it is fixed.
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
    // Claim the invoice email so overlapping runs can't both send it. Past the
    // retry window with nothing sent, the charge is cancelled here, not dropped.
    const claim = await db.runTransaction(async (tx) => {
      const c = (await tx.get(chargeRef)).data();
      if (!c || c.status !== "pending" || c.emailedTo) return { state: "done" as const };
      if (claimFresh(c, now)) return { state: "busy" as const };
      // Counted from the charge, so a charge created late still gets its email.
      const createdMs = toMillis(c.createdAt) ?? now.getTime();
      if (now.getTime() - createdMs > INVOICE_EMAIL_RETRY_DAYS * DAY_MS) {
        // A send that was attempted may have gone out: the debt stands.
        if (c.emailAttemptedAt) return { state: "done" as const };
        tx.update(chargeRef, { status: "canceled", tokenHash: null, updatedAt: FieldValue.serverTimestamp() });
        return { state: "expired" as const };
      }
      tx.update(chargeRef, { invoiceEmailClaimedAt: FieldValue.serverTimestamp() });
      return { state: "claimed" as const, c };
    });
    if (claim.state === "busy") return;
    if (claim.state === "expired") {
      const why = "invoice could not be sent";
      await recordWithheld({
        sub, month: p.month, chargeId, ledgerRef, charge: "canceled", why, carryBackCents: frozen.carriedInCents ?? 0,
      });
      await q.ref.delete();
      return refuse(`${why} within ${INVOICE_EMAIL_RETRY_DAYS} days; the charge was cancelled and the month withheld`);
    }
    if (claim.state !== "claimed") {
      await q.ref.delete();
      return;
    }
    const release = () => chargeRef.update({ invoiceEmailClaimedAt: FieldValue.delete() });
    const stop = async (why: string): Promise<never> => {
      await release();
      return refuse(why);
    };
    // Nobody to email (Stripe), or no sender: the entry stays queued, so a fix
    // gets the invoice on the next run. Everything the send needs is checked
    // BEFORE a link is staged.
    if (!to) return stop("no one to email the invoice to: set the workspace's account contact");
    const sender = await resolveUsageSender(sub.id);
    if (!sender) return stop("no email sender is configured for this workspace");
    // The raw pay token is never stored: staged for this email, live once it is sent.
    let link: { url: string; hash: string };
    try {
      link = stageChargeLink(chargeId);
    } catch (err) {
      await release();
      return held(err);
    }
    const c = claim.c;
    // Stamped before the send so a run that dies mid-send is not read as "never sent".
    await chargeRef.update({ emailAttemptedAt: FieldValue.serverTimestamp() });
    const sent = await sendUsageEmail({
      sender,
      kind: "invoice",
      to,
      sub,
      month: p.month,
      amountCents: Number(c.amountCents ?? frozen.totalCents),
      currency: String(c.currency ?? frozen.currency),
      lineItems: (c.lineItems as UsageChargeLine[] | undefined) ?? frozen.lineItems,
      payUrl: link.url,
      dueAt: new Date(toMillis(c.dueAt) ?? dueAt.getTime()),
    });
    if (!sent) {
      // Known not sent: tomorrow's run tries again (and a switch-off may still cancel it).
      await chargeRef.update({ emailAttemptedAt: FieldValue.delete() });
      return stop("the invoice email could not be sent");
    }
    try {
      await commitChargeLink(chargeId, link.hash);
    } catch (err) {
      await release();
      return held(err);
    }
    // At-least-once: if this write (or the delete after it) fails, the entry
    // stays queued and the invoice is sent again once the claim times out.
    await chargeRef.update({ emailedTo: to, updatedAt: FieldValue.serverTimestamp() });
    await q.ref.delete();
  });
  return { charged, failed, refusals };
}
