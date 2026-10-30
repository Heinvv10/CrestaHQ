import "server-only";

import { Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { localDay } from "@/lib/billing/usage";
import { inPool, reason, toMillis } from "@/lib/server/usage-billing-shared";

/**
 * `subAccounts/{id}.usageOverdue`: the oldest overdue usage charge, which the
 * client guard turns into a banner (and, only if the agency allows it, a
 * paywall). Server-written only: `subAccounts` is `allow write: if false` in
 * firestore.rules, so no client can set or clear it.
 *
 * A flag exists only while ALL of these hold, re-read in one transaction:
 *   - the client's `usageRebillingEnabled` AND the agency's are `=== true`;
 *   - a usage charge is `pending`, was emailed (`emailedTo` set) and is past
 *     its due day (server-local, like the rest of the usage close).
 * Anything else clears it, so a switch turned off lifts the banner and wall.
 *
 * FAILS OPEN, the one deliberate exception to fail-closed in this area: if the
 * refresh cannot read what it needs, it clears the flag instead of keeping or
 * setting one. A bug here must never wall a live client's workspace; the cost
 * is a banner that lingers one day less, because the daily close re-sweeps.
 */

export async function refreshUsageOverdue(
  subAccountId: string,
  now: Date = new Date(),
): Promise<void> {
  const db = getAdminDb();
  try {
    const subRef = db.doc(`subAccounts/${subAccountId}`);
    const today = localDay(now.getTime());
    // One transaction, so a payment landing mid-refresh can't be overwritten
    // by a stale "still overdue" read.
    await db.runTransaction(async (tx) => {
      const subSnap = await tx.get(subRef);
      if (!subSnap.exists) return;
      const sub = subSnap.data() ?? {};
      const agencyId = typeof sub.agencyId === "string" ? sub.agencyId : "";
      const agency = agencyId ? (await tx.get(db.doc(`agencies/${agencyId}`))).data() : undefined;
      const rebilled = sub.usageRebillingEnabled === true && agency?.usageRebillingEnabled === true;
      const charges = rebilled
        ? await tx.get(
            db
              .collection("billingCharges")
              .where("subAccountId", "==", subAccountId)
              .where("kind", "==", "usage")
              .where("status", "==", "pending"),
          )
        : null;
      const oldest = (charges?.docs ?? [])
        .map((d) => ({ d, dueMs: toMillis(d.data().dueAt) }))
        .filter(
          (x): x is { d: typeof x.d; dueMs: number } =>
            x.dueMs !== null && !!x.d.data().emailedTo && localDay(x.dueMs) < today,
        )
        .sort((a, b) => a.dueMs - b.dueMs)[0];
      const current = sub.usageOverdue as
        | { chargeId?: string; paywall?: boolean }
        | null
        | undefined;
      if (!oldest) {
        if (current) tx.update(subRef, { usageOverdue: null });
        return;
      }
      const paywall = agency?.usagePaywallEnabled === true;
      if (current?.chargeId === oldest.d.id && current.paywall === paywall) return;
      const c = oldest.d.data();
      tx.update(subRef, {
        usageOverdue: {
          chargeId: oldest.d.id,
          since: Timestamp.fromMillis(oldest.dueMs),
          amountCents: Number(c.amountCents ?? 0),
          currency: String(c.currency ?? "zar"),
          usageMonth: typeof c.usageMonth === "string" ? c.usageMonth : null,
          paywall,
        },
      });
    });
  } catch (err) {
    console.warn(`[usage-overdue] refresh failed, clearing the flag sa=${subAccountId}: ${reason(err)}`);
    await db
      .doc(`subAccounts/${subAccountId}`)
      .update({ usageOverdue: null })
      .catch((clearErr) =>
        console.warn(`[usage-overdue] flag not cleared sa=${subAccountId}: ${reason(clearErr)}`),
      );
  }
}

/** Re-checks every client of one agency that is flagged (after a switch or the wall setting changes). */
export async function refreshAgencyUsageOverdue(agencyId: string, now: Date = new Date()): Promise<void> {
  try {
    const flagged = await getAdminDb().collection("subAccounts").where("usageOverdue", "!=", null).get();
    const ids = flagged.docs.filter((d) => d.data().agencyId === agencyId).map((d) => d.id);
    await inPool(ids, (id) => refreshUsageOverdue(id, now));
  } catch (err) {
    console.warn(`[usage-overdue] agency refresh failed ag=${agencyId}: ${reason(err)}`);
  }
}

/**
 * The daily sweep: every client with a pending usage charge (one that has just
 * gone overdue) plus every client already flagged (one a failed refresh left
 * behind, or whose switch went off). Never throws.
 */
export async function sweepUsageOverdue(now: Date = new Date()): Promise<number> {
  try {
    const db = getAdminDb();
    const [pending, flagged] = await Promise.all([
      db.collection("billingCharges").where("kind", "==", "usage").where("status", "==", "pending").get(),
      db.collection("subAccounts").where("usageOverdue", "!=", null).get(),
    ]);
    const ids = new Set<string>();
    for (const d of pending.docs) {
      const id = d.data().subAccountId;
      if (typeof id === "string" && id) ids.add(id);
    }
    for (const d of flagged.docs) ids.add(d.id);
    await inPool([...ids], (id) => refreshUsageOverdue(id, now));
    return ids.size;
  } catch (err) {
    console.warn(`[usage-overdue] sweep failed: ${reason(err)}`);
    return 0;
  }
}
