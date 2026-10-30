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
import { billingRecipient } from "@/lib/server/usage-billing-recipient";
import { resolveUsageSender, sendUsageEmail } from "@/lib/server/usage-billing-email";
import {
  announceWithheld,
  claimFresh,
  INVOICE_EMAIL_RETRY_DAYS,
  queuedPastWindow,
  withheldPatch,
  withholdUnsent,
  type WithheldWhy,
} from "@/lib/server/usage-billing-withhold";
import { getBillingProvider } from "@/lib/billing/provider";
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
    const refuse = (why: string, alreadyFlagged = false): never => {
      throw new UsageChargeRefused(sub.agencyId, sub.id, p.month, why, alreadyFlagged);
    };
    const held = (err: unknown): never => {
      throw err instanceof BillingError ? new UsageChargeRefused(sub.agencyId, sub.id, p.month, err.message) : err;
    };
    const carryBackCents = frozen.carriedInCents ?? 0;
    // Every withhold goes through the same transactional charge check. Returns
    // "stands" (a charge that was emailed or attempted: carry on, nothing written)
    // or "busy" (an email is being sent now: leave it); a withheld month ends the
    // run here as a one-time refusal that is already flagged.
    const withholdOrStand = async (why: WithheldWhy, message: string): Promise<"stands" | "busy"> => {
      const verdict = await withholdUnsent({ sub, month: p.month, chargeId, now, ledgerRef, carryBackCents, why });
      if (verdict !== "withheld") return verdict;
      await q.ref.delete();
      return refuse(message, true);
    };
    const chargeRef = db.doc(`billingCharges/${chargeId}`);
    // Checked before any path is built from it.
    if (!sub.agencyId) return refuse("the sub-account has no agency");

    // Fail closed: the full eligibility rule (both switches AND `since` at or
    // before the month's start, as at the freeze) is applied again to the
    // stored docs. A client toggled off and on since the freeze fails it.
    // Nothing is billed unless the invoice already went out.
    const agencyDoc = (await db.doc(`agencies/${sub.agencyId}`).get()).data();
    if (unbillableReason(agencyDoc, sub as unknown as Record<string, unknown>, p.month)) {
      const verdict = await withholdUnsent({ sub, month: p.month, chargeId, now, ledgerRef, carryBackCents });
      if (verdict === "withheld") {
        await q.ref.delete();
        return;
      }
      if (verdict === "busy") return;
    }

    // An amount over the ceiling can never be created as a charge. It is held
    // (reported daily) for the retry window, then withheld rather than repeated forever.
    if (frozen.totalCents > MAX_PRICE_CENTS && queuedPastWindow(p, now)) {
      const msg = `over ceiling: ${frozen.totalCents} exceeds ${MAX_PRICE_CENTS} minor units for ${INVOICE_EMAIL_RETRY_DAYS} days; the month was withheld`;
      if ((await withholdOrStand("over ceiling", msg)) === "busy") return;
    }

    const to = await billingRecipient(sub);
    // Paystack cannot open a payment page without an email. Held (reported daily)
    // for the retry window, then withheld, so an old month is never billed months later.
    if (!to && getBillingProvider().id === "paystack" && queuedPastWindow(p, now)) {
      const msg = `no billing email for ${INVOICE_EMAIL_RETRY_DAYS} days; the month was withheld`;
      if ((await withholdOrStand("no billing email", msg)) === "busy") return;
    }
    // The due date counts from when the charge is actually created.
    const dueAt = new Date(now.getTime() + USAGE_PAYMENT_TERMS_DAYS * DAY_MS);
    // A charge that already exists is never created again (so none of the
    // creation refusals below can apply to it). Otherwise a refusal (Paystack with
    // no email, an amount over the ceiling) throws and the entry stays queued, so
    // it is reported every day until it is fixed.
    if (!(await chargeRef.get()).exists) {
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
      }).catch(async (err) => {
        // A refusal that outlives the retry window is withheld, so no month is
        // ever held for more than a week or so (and a carry restored by a late
        // withhold cannot miss the next month's close).
        if (err instanceof BillingError && queuedPastWindow(p, now)) {
          const msg = `charge could not be created for ${INVOICE_EMAIL_RETRY_DAYS} days (${err.message}); the month was withheld`;
          if ((await withholdOrStand("charge could not be created", msg)) === "busy") return null;
          return { created: false, chargeId };
        }
        return held(err);
      });
      if (created === null) return;
      if (created.created) charged++;
    }

    // Claim the invoice email so overlapping runs can't both send it. Past the
    // retry window with nothing sent, the charge is cancelled here, not dropped.
    const claim = await db.runTransaction(async (tx) => {
      const c = (await tx.get(chargeRef)).data();
      if (!c || c.status !== "pending" || c.emailedTo) return { state: "done" as const };
      if (claimFresh(c, now)) return { state: "busy" as const };
      // Counted from the charge, so a charge created late still gets its email.
      const createdMs = toMillis(c.createdAt) ?? now.getTime();
      if (now.getTime() - createdMs > INVOICE_EMAIL_RETRY_DAYS * DAY_MS) {
        // A send that was attempted may have gone out: the debt stands, and a
        // person is told it cannot be known (not a silent drop).
        if (c.emailAttemptedAt) return { state: "unknown" as const };
        // The cancel and the withheld ledger are ONE commit: a crash cannot lose the carry.
        tx.update(chargeRef, { status: "canceled", tokenHash: null, updatedAt: FieldValue.serverTimestamp() });
        tx.update(ledgerRef, withheldPatch("invoice could not be sent", carryBackCents));
        return { state: "expired" as const };
      }
      tx.update(chargeRef, { invoiceEmailClaimedAt: FieldValue.serverTimestamp() });
      return { state: "claimed" as const, c };
    });
    if (claim.state === "busy") return;
    if (claim.state === "expired") {
      const why = "invoice could not be sent";
      await announceWithheld({ sub, month: p.month, chargeId, charge: "canceled", why, carryBackCents });
      await q.ref.delete();
      return refuse(`${why} within ${INVOICE_EMAIL_RETRY_DAYS} days; the charge was cancelled and the month withheld`, true);
    }
    if (claim.state === "unknown") {
      await q.ref.delete();
      return refuse(
        `the invoice send state is unknown after ${INVOICE_EMAIL_RETRY_DAYS} days (a send was attempted, none confirmed): check the charge ${chargeId}`,
      );
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
      // Paid or cancelled while the email was going out: the email was sent and
      // the link has nothing left to do. Done, and quiet (not a refusal).
      if (!(err instanceof BillingError)) {
        await release();
        throw err;
      }
      console.warn(`[usage-close] ${chargeId} is no longer payable after its invoice went out: ${err.message}`);
    }
    // At-least-once: if this write (or the delete after it) fails, the entry
    // stays queued and the invoice is sent again once the claim times out.
    await chargeRef.update({ emailedTo: to, updatedAt: FieldValue.serverTimestamp() });
    await q.ref.delete();
  });
  return { charged, failed, refusals };
}
