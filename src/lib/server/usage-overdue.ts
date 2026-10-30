import "server-only";

import { Timestamp } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { localDay } from "@/lib/billing/usage";
import { inPool, reason, toMillis } from "@/lib/server/usage-billing-shared";
import { backoffFor, sleep } from "@/lib/server/usage-retry-delay";

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
            x.dueMs !== null &&
            !!x.d.data().emailedTo &&
            // A charge of nothing owes nothing (the close never mints one; this is belt and braces).
            Number(x.d.data().amountCents) > 0 &&
            localDay(x.dueMs) < today,
        )
        .sort((a, b) => a.dueMs - b.dueMs)[0];
      const current = sub.usageOverdue as
        | { chargeId?: string; paywall?: boolean; paywallSince?: unknown; rebillingSince?: unknown }
        | null
        | undefined;
      if (!oldest) {
        if (current) tx.update(subRef, { usageOverdue: null });
        return;
      }
      const paywall = agency?.usagePaywallEnabled === true;
      // When the paywall was last turned on: the wall waits 7 days from then, so
      // turning it on never walls a long-overdue client at once.
      const paywallSinceMs = paywall ? toMillis(agency?.usagePaywallEnabledAt) : null;
      // When this client's switch last turned on: re-enabling a client gives it a fresh 7 days too.
      const rebillingSinceMs = toMillis(sub.usageRebillingSince);
      if (
        current?.chargeId === oldest.d.id &&
        current.paywall === paywall &&
        toMillis(current.paywallSince) === paywallSinceMs &&
        toMillis(current.rebillingSince) === rebillingSinceMs
      ) {
        return;
      }
      const c = oldest.d.data();
      tx.update(subRef, {
        usageOverdue: {
          chargeId: oldest.d.id,
          since: Timestamp.fromMillis(oldest.dueMs),
          amountCents: Number(c.amountCents ?? 0),
          currency: String(c.currency ?? "zar"),
          usageMonth: typeof c.usageMonth === "string" ? c.usageMonth : null,
          paywall,
          paywallSince: paywallSinceMs === null ? null : Timestamp.fromMillis(paywallSinceMs),
          rebillingSince: rebillingSinceMs === null ? null : Timestamp.fromMillis(rebillingSinceMs),
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

/**
 * Re-checks every client of one agency that is flagged (after a switch or the
 * wall setting changes). The scan is retried twice; returns false if it still
 * failed, so the caller can say so instead of claiming clients were restored.
 * The daily sweep is the backstop either way.
 */
export async function refreshAgencyUsageOverdue(
  agencyId: string,
  now: Date = new Date(),
  attempts = 3,
): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const flagged = await getAdminDb().collection("subAccounts").where("usageOverdue", "!=", null).get();
      const ids = flagged.docs.filter((d) => d.data().agencyId === agencyId).map((d) => d.id);
      await inPool(ids, (id) => refreshUsageOverdue(id, now));
      return true;
    } catch (err) {
      console.warn(`[usage-overdue] agency refresh failed ag=${agencyId} attempt=${attempt}/${attempts}: ${reason(err)}`);
      if (attempt < attempts) await sleep(backoffFor(attempt));
    }
  }
  return false;
}

/**
 * The daily sweep: every client with a pending usage charge (one that has just
 * gone overdue) plus every client already flagged (one a failed refresh left
 * behind, or whose switch went off). The scan is tried three times; if it
 * still fails this THROWS, so the daily job reports it instead of leaving
 * walls up unseen. Per-client refreshes never throw (they fail open).
 */
export async function sweepUsageOverdue(now: Date = new Date(), attempts = 3): Promise<number> {
  const db = getAdminDb();
  for (let attempt = 1; ; attempt++) {
    try {
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
      console.warn(`[usage-overdue] sweep scan failed attempt=${attempt}/${attempts}: ${reason(err)}`);
      if (attempt >= attempts) throw err;
      await sleep(backoffFor(attempt));
    }
  }
}
