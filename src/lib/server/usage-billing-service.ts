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
import { processPendingCharges, sendDueReminders } from "@/lib/server/usage-billing-dispatch";
import {
  inPool,
  PENDING_COLLECTION,
  toMillis,
  type PendingChargeDoc,
  type UsageClosedSnapshot,
} from "@/lib/server/usage-billing-shared";
import {
  formatUsageMonth,
  monthBefore,
  monthEndExclusive,
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

/** How far back an amount below the minimum can still be carried from. */
const CARRY_LOOKBACK_MONTHS = 12;

const UNIT_LABEL: Record<UsageUnit, string> = {
  emailsSent: "Emails",
  smsSegments: "SMS segments",
  whatsappMessages: "WhatsApp messages",
  aiTokens: "AI tokens",
  voiceSeconds: "Voice minutes",
};

/**
 * Sub-minimum amount carried into `month` from the last billed month before
 * it, stepping over skipped months so a gap can't lose it.
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
    return closed.currency === currency
      ? { cents: Math.max(0, closed.carryOutCents ?? 0), fromMonth: m }
      : { cents: 0, fromMonth: null };
  }
  return { cents: 0, fromMonth: null };
}

export async function runUsageClose(now: Date = new Date()): Promise<{
  closed: number;
  charged: number;
  reminded: number;
  failed: number;
}> {
  const subs = await getAdminDb()
    .collection("subAccounts")
    .where("usageRebillingEnabled", "==", true)
    .get();
  const month = previousMonthKey(now);
  let closed = 0;
  const failedFreezes = await inPool(subs.docs, async (snap) => {
    const sub = { ...(snap.data() as SubAccountDoc), id: snap.id };
    if (await freezeMonthForSubAccount({ sub, month })) closed++;
  });
  const pending = await processPendingCharges(now);
  const reminders = await sendDueReminders(now);
  return {
    closed,
    charged: pending.charged,
    reminded: reminders.sent,
    failed: failedFreezes + pending.failed + reminders.failed,
  };
}

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
  const monthEnd = monthEndExclusive(month).getTime();
  const currency = usageCurrency(sub.billing).toLowerCase();

  return db.runTransaction(async (tx) => {
    const [snap, subSnap] = await Promise.all([tx.get(ref), tx.get(db.doc(`subAccounts/${sub.id}`))]);
    const usage = (snap.data() as (UsageMonthDoc & { closed?: UsageClosedSnapshot }) | undefined) ?? {};
    if (usage.closed) return false;
    const fresh = subSnap.data() ?? {};
    const agencyId = typeof fresh.agencyId === "string" ? fresh.agencyId : "";
    const agency = agencyId ? (await tx.get(db.doc(`agencies/${agencyId}`))).data() : undefined;

    // Only a month during which both switches were already on is billed. A
    // switch turned off and on again after the month ended counts as off.
    const onBeforeEnd = (since: unknown) => {
      const ms = toMillis(since);
      return ms === null || ms < monthEnd;
    };
    const billable =
      agency?.usageRebillingEnabled === true &&
      fresh.usageRebillingEnabled === true &&
      onBeforeEnd(agency.usageRebillingSince) &&
      onBeforeEnd(fresh.usageRebillingSince);

    if (!billable) {
      const skipped: UsageClosedSnapshot = {
        at: FieldValue.serverTimestamp(),
        skipped: true,
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
      return true;
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
    return true;
  });
}

