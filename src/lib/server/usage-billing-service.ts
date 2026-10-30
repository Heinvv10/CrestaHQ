import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { usageCurrency } from "@/lib/billing/currency";
import {
  computeOverage,
  getEffectiveQuotas,
  getEffectiveRates,
} from "@/lib/server/usage-meter";
import { usageChargeId } from "@/lib/server/billing-service";
import { recordBillingEvent } from "@/lib/server/billing-lifecycle";
import { processPendingCharges } from "@/lib/server/usage-billing-dispatch";
import { sendDueReminders } from "@/lib/server/usage-billing-reminders";
import { sweepUsageOverdue } from "@/lib/server/usage-overdue";
import {
  inPool,
  PENDING_COLLECTION,
  unbillableReason,
  type PendingChargeDoc,
  type UsageRefusal,
  type UsageClosedSnapshot,
} from "@/lib/server/usage-billing-shared";
import {
  formatUsageMonth,
  monthBefore,
  previousMonthKey,
  USAGE_MIN_CHARGE_CENTS,
} from "@/lib/billing/usage";
import type { UsageChargeLine } from "@/types/billing";
import type { SubAccountDoc } from "@/types";
import type { UsageMonthDoc, UsageUnit } from "@/types/usage";

/**
 * Daily month close (run from daily-housekeeping): freeze last month, queue
 * and mint its charge, email it, then send reminders. Every step is
 * idempotent, so a retry or a second run changes nothing.
 *
 * Money only moves when BOTH switches are on (agency master + this client,
 * each read `=== true`): at freeze, and again when the charge is minted.
 * Nothing here charges a card; a charge is a `billingCharges` doc with a pay
 * link the client opens. Switch the master off and nothing new is minted.
 *
 * Not here (G3): the overdue flag on the sub-account and the banner/paywall.
 */

/** How far back to look for the last billed month. */
const CARRY_LOOKBACK_MONTHS = 12;
/** A carry older than this many months before the one closing is never applied. */
const CARRY_MAX_AGE_MONTHS = 2;

const UNIT_LABEL: Record<UsageUnit, string> = {
  emailsSent: "Emails",
  smsSegments: "SMS segments",
  whatsappMessages: "WhatsApp messages",
  aiTokens: "AI tokens",
  voiceSeconds: "Voice minutes",
};

/**
 * Sub-minimum amount carried into `month` from the last billed month before
 * it, stepping over skipped and empty months so a gap can't lose it. A carry
 * is applied only from one of the two months before `month`, and only in the
 * same currency; otherwise it is NOT applied, a warning names the amount, and
 * it stays recorded as `carryOutCents` on that month's ledger doc.
 */
export async function carriedInFor(
  subAccountId: string,
  month: string,
  currency: string,
  read: (ref: FirebaseFirestore.DocumentReference) => Promise<FirebaseFirestore.DocumentSnapshot> = (ref) =>
    ref.get(),
): Promise<{ cents: number; fromMonth: string | null }> {
  const db = getAdminDb();
  let m = month;
  for (let i = 0; i < CARRY_LOOKBACK_MONTHS; i++) {
    m = monthBefore(m);
    const closed = ((await read(db.doc(`subAccounts/${subAccountId}/usage/${m}`))).data() as
      | { closed?: UsageClosedSnapshot }
      | undefined)?.closed;
    if (!closed || closed.skipped) continue;
    const cents = Math.max(0, closed.carryOutCents ?? 0);
    if (cents === 0) return { cents: 0, fromMonth: null };
    const why =
      closed.currency !== currency
        ? `currency ${closed.currency} is not ${currency}`
        : i >= CARRY_MAX_AGE_MONTHS
          ? `it is from ${m}, older than ${CARRY_MAX_AGE_MONTHS} months`
          : null;
    if (why) {
      console.warn(`[usage-close] carry of ${cents} not applied sa=${subAccountId} month=${month}: ${why}`);
      return { cents: 0, fromMonth: null };
    }
    return { cents, fromMonth: m };
  }
  return { cents: 0, fromMonth: null };
}

export async function runUsageClose(now: Date = new Date()): Promise<{
  closed: number;
  charged: number;
  reminded: number;
  /** Unexpected or transient errors: the job answers 500 for these. */
  failed: number;
  /** Permanent refusals (see `UsageChargeRefused`): held and reported, not a failure. */
  refusals: UsageRefusal[];
}> {
  const subs = await getAdminDb()
    .collection("subAccounts")
    .where("usageRebillingEnabled", "==", true)
    .get();
  const month = previousMonthKey(now);
  let closed = 0;
  const freezes = await inPool(subs.docs, async (snap) => {
    const sub = { ...(snap.data() as SubAccountDoc), id: snap.id };
    if (await freezeMonthForSubAccount({ sub, month })) closed++;
  });
  const pending = await processPendingCharges(now);
  const reminders = await sendDueReminders(now);
  // After the reminders, so a charge that has just gone overdue is flagged the same day.
  // A scan that still fails after its retries counts as a failure: the job answers 500
  // and QStash retries, rather than walls standing unseen.
  let sweepFailed = 0;
  await sweepUsageOverdue(now).catch((err) => {
    sweepFailed = 1;
    console.error(`[usage-close] overdue sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  return {
    closed,
    charged: pending.charged,
    reminded: reminders.sent,
    failed: freezes.failed + pending.failed + reminders.failed + sweepFailed,
    refusals: [...freezes.refusals, ...pending.refusals, ...reminders.refusals],
  };
}

type FreezeOutcome =
  | { kind: "already" }
  | { kind: "skipped"; agencyId: string; reason: string }
  | { kind: "frozen"; agencyId: string; totalCents: number; currency: string; chargeId: string | null };

/** Freeze `month` for one client once, queueing its charge in the same write. */
export async function freezeMonthForSubAccount(input: {
  sub: SubAccountDoc;
  month: string;
}): Promise<boolean> {
  const { sub, month } = input;
  const db = getAdminDb();
  const ref = db.doc(`subAccounts/${sub.id}/usage/${month}`);
  // Every daily run reaches here; skip the lookups once the month is closed.
  if ((await ref.get()).data()?.closed) return false;

  const [quotas, rates] = await Promise.all([getEffectiveQuotas(sub.id, sub), getEffectiveRates(sub.id, sub)]);
  const currency = usageCurrency(sub.billing).toLowerCase();

  const outcome = await db.runTransaction(async (tx): Promise<FreezeOutcome> => {
    const [snap, subSnap] = await Promise.all([tx.get(ref), tx.get(db.doc(`subAccounts/${sub.id}`))]);
    const usage = (snap.data() as (UsageMonthDoc & { closed?: UsageClosedSnapshot }) | undefined) ?? {};
    if (usage.closed) return { kind: "already" };
    const fresh = subSnap.data() ?? {};
    const agencyId = typeof fresh.agencyId === "string" ? fresh.agencyId : "";
    const agency = agencyId ? (await tx.get(db.doc(`agencies/${agencyId}`))).data() : undefined;

    const skipReason = unbillableReason(agency, fresh, month);

    if (skipReason) {
      const skipped: UsageClosedSnapshot = {
        at: FieldValue.serverTimestamp(),
        skipped: true,
        skippedReason: skipReason,
        totalCents: 0,
        currency,
        lineItems: [],
        ratesSnapshot: null,
        includedSnapshot: null,
        carriedInCents: 0,
        carryOutCents: 0,
        chargeId: null,
      };
      tx.set(ref, { closed: skipped }, { merge: true });
      return { kind: "skipped", agencyId, reason: skipReason };
    }

    const carry = await carriedInFor(sub.id, month, currency, (r) => tx.get(r));
    const overage = computeOverage(usage, quotas, rates);
    const lineItems: UsageChargeLine[] = [];
    for (const [unit, v] of Object.entries(overage.perUnit) as [
      UsageUnit,
      { overUnits: number; cents: number },
    ][]) {
      if (v.cents <= 0) continue;
      // Voice is prorated by the second, so show minutes to one decimal.
      const detail =
        unit === "voiceSeconds"
          ? `${(v.overUnits / 60).toFixed(1)} billable min`
          : `${v.overUnits.toLocaleString("en-US")} billable`;
      lineItems.push({ label: UNIT_LABEL[unit], amountCents: v.cents, detail });
    }
    if (carry.cents > 0) {
      lineItems.push({
        label: `Carried from ${formatUsageMonth(carry.fromMonth ?? monthBefore(month))}`,
        amountCents: carry.cents,
        detail: "Below the minimum charge last month",
      });
    }
    const totalCents = overage.totalCents + carry.cents;
    const charge = totalCents >= USAGE_MIN_CHARGE_CENTS;
    const chargeId = charge ? usageChargeId(sub.id, month) : null;
    const frozen: UsageClosedSnapshot = {
      at: FieldValue.serverTimestamp(),
      totalCents,
      currency,
      lineItems,
      ratesSnapshot: rates,
      includedSnapshot: quotas,
      carriedInCents: carry.cents,
      carryOutCents: charge ? 0 : totalCents,
      chargeId,
    };
    tx.set(ref, { closed: frozen }, { merge: true });
    if (chargeId) {
      const pending: PendingChargeDoc = { subAccountId: sub.id, month, createdAt: FieldValue.serverTimestamp() };
      tx.set(db.doc(`${PENDING_COLLECTION}/${chargeId}`), pending);
    }
    return { kind: "frozen", agencyId, totalCents, currency, chargeId };
  });

  if (outcome.kind === "already") return false;
  // Audited after the commit (a retried transaction would repeat it).
  recordBillingEvent({
    agencyId: outcome.agencyId,
    subAccountId: sub.id,
    event: outcome.kind === "skipped" ? "usage.skipped" : "usage.frozen",
    detail:
      outcome.kind === "skipped"
        ? { month, reason: outcome.reason }
        : { month, totalCents: outcome.totalCents, currency: outcome.currency, chargeId: outcome.chargeId },
  });
  return true;
}

