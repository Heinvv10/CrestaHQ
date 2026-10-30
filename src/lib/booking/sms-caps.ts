import "server-only";

import { createHash } from "node:crypto";
import { FieldValue, type DocumentReference } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";

/**
 * Daily caps on booking texts. The public booking page lets anyone make us
 * text a number of their choosing, so the volume is bounded in Firestore, not
 * in memory (it must hold across instances and restarts):
 *
 *   - per destination number per sub-account: BOOKING_SMS_PER_NUMBER_PER_DAY
 *     (one booking is a confirmation plus two reminders, so 6 is two bookings)
 *   - per sub-account: BOOKING_SMS_PER_SUBACCOUNT_PER_DAY
 *
 * `subAccounts/{id}/bookingSmsCaps/{YYYY-MM-DD}` holds the sub-account's
 * count for that UTC day and `.../{YYYY-MM-DD}_{sha256(number)[:16]}` the
 * number's (the number is hashed, never stored). Server-only, default deny.
 * Both are read, checked and incremented in ONE transaction, together with
 * the create-only claim doc of the text when there is one, so two concurrent
 * deliveries can neither both pass the last slot nor both send.
 */

export const BOOKING_SMS_PER_NUMBER_PER_DAY = 6;
export const BOOKING_SMS_PER_SUBACCOUNT_PER_DAY = 200;

/** Days an unused counter doc stays before a sweep may remove it (no sweep exists yet). */
const COUNTER_TTL_MS = 3 * 86_400_000;

export type SmsReservation =
  | { ok: true; day: string }
  | { ok: false; reason: "already_sent" | "cap_number" | "cap_subaccount" | "cap_unavailable" };

interface Target {
  subAccountId: string;
  agencyId: string;
  /** The E.164 destination. */
  to: string;
  /** Create-only marker of THIS text (a redelivery finds it and sends nothing). */
  claimPath?: string;
}

const dayKey = (now: Date) => now.toISOString().slice(0, 10);

function refs(subAccountId: string, to: string, day: string) {
  const db = getAdminDb();
  const hash = createHash("sha256").update(to).digest("hex").slice(0, 16);
  const base = `subAccounts/${subAccountId}/bookingSmsCaps`;
  return { sub: db.doc(`${base}/${day}`), number: db.doc(`${base}/${day}_${hash}`) };
}

const countOf = (snap: { exists: boolean; data: () => unknown }): number => {
  const n = snap.exists ? (snap.data() as { count?: unknown }).count : 0;
  return typeof n === "number" && n > 0 ? n : 0;
}

/**
 * Claim `claimPath` (when given) and take one slot of each cap, atomically.
 * Fails closed: a transaction that cannot commit (contention) sends nothing.
 */
export async function reserveBookingSms(t: Target, now: Date = new Date()): Promise<SmsReservation> {
  const db = getAdminDb();
  const day = dayKey(now);
  const { sub, number } = refs(t.subAccountId, t.to, day);
  const claim: DocumentReference | null = t.claimPath ? db.doc(t.claimPath) : null;
  try {
    return await db.runTransaction(async (tx): Promise<SmsReservation> => {
      const [claimSnap, subSnap, numberSnap] = await Promise.all([
        claim ? tx.get(claim) : Promise.resolve(null),
        tx.get(sub),
        tx.get(number),
      ]);
      if (claimSnap?.exists) return { ok: false, reason: "already_sent" };
      const subCount = countOf(subSnap);
      const numberCount = countOf(numberSnap);
      if (numberCount >= BOOKING_SMS_PER_NUMBER_PER_DAY) return { ok: false, reason: "cap_number" };
      if (subCount >= BOOKING_SMS_PER_SUBACCOUNT_PER_DAY) return { ok: false, reason: "cap_subaccount" };
      const expiresAt = new Date(now.getTime() + COUNTER_TTL_MS);
      tx.set(sub, { count: subCount + 1, subAccountId: t.subAccountId, agencyId: t.agencyId, expiresAt });
      tx.set(number, { count: numberCount + 1, subAccountId: t.subAccountId, agencyId: t.agencyId, expiresAt });
      if (claim) {
        tx.set(claim, { agencyId: t.agencyId, subAccountId: t.subAccountId, claimedAt: FieldValue.serverTimestamp() });
      }
      return { ok: true, day };
    });
  } catch (err) {
    console.warn("[booking/sms] cap reservation failed", err instanceof Error ? err.message : String(err));
    return { ok: false, reason: "cap_unavailable" };
  }
}

/** Gives back a reservation whose text was NOT sent (held by quiet hours): frees the claim and both slots. */
export async function releaseBookingSms(t: Target, day: string): Promise<void> {
  const db = getAdminDb();
  const { sub, number } = refs(t.subAccountId, t.to, day);
  const claim = t.claimPath ? db.doc(t.claimPath) : null;
  try {
    await db.runTransaction(async (tx) => {
      const [subSnap, numberSnap] = await Promise.all([tx.get(sub), tx.get(number)]);
      tx.update(sub, { count: Math.max(0, countOf(subSnap) - 1) });
      tx.update(number, { count: Math.max(0, countOf(numberSnap) - 1) });
      if (claim) tx.delete(claim);
    });
  } catch (err) {
    console.error("[booking/sms] cap release failed", err instanceof Error ? err.message : String(err));
  }
}
