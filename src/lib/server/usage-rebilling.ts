import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { recordAuditEvent } from "@/lib/audit/record";
import { refreshAgencyUsageOverdue, refreshUsageOverdue } from "@/lib/server/usage-overdue";

/**
 * The two usage-rebilling switches (`agencies/{id}.usageRebillingEnabled`,
 * `subAccounts/{id}.usageRebillingEnabled`). Every flip re-reads and writes
 * inside one transaction, so concurrent toggles write one change, one
 * `usageRebillingSince` and one audit row. Audit rows are written after the
 * commit, from what the transaction actually changed.
 */

/** Client docs one cascade transaction switches off (a transaction holds 500 writes). */
export const REBILLING_CASCADE_CHUNK = 400;

/** A refusal the caller shows as a 400. */
export class UsageRebillingRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageRebillingRefusedError";
  }
}

function auditFlip(
  actorUid: string,
  agencyId: string,
  subAccountId: string | null,
  before: boolean,
  after: boolean,
): Promise<void> {
  return recordAuditEvent(getAdminDb(), {
    action: "usage_rebilling.updated",
    actor: { type: "user", id: actorUid },
    target: subAccountId
      ? { type: "subAccount", id: subAccountId }
      : { type: "agency", id: agencyId },
    agencyId,
    subAccountId,
    changes: [{ field: "usageRebillingEnabled", before, after }],
  });
}

/**
 * One client's switch. Switching on is refused unless the master switch on
 * the sub-account's STORED agency is on, re-read in the same transaction.
 */
export async function setClientUsageRebilling(
  subAccountId: string,
  on: boolean,
  actorUid: string,
): Promise<{ changed: boolean }> {
  const db = getAdminDb();
  const subRef = db.doc(`subAccounts/${subAccountId}`);
  const result = await db.runTransaction(async (tx) => {
    const data = (await tx.get(subRef)).data();
    const agencyId = typeof data?.agencyId === "string" ? data.agencyId : "";
    if (!agencyId) throw new UsageRebillingRefusedError("Sub-account not found.");
    if (on) {
      const agency = await tx.get(db.doc(`agencies/${agencyId}`));
      if (agency.data()?.usageRebillingEnabled !== true) {
        throw new UsageRebillingRefusedError(
          "Turn on Usage rebilling for the agency first (Agency → Client billing).",
        );
      }
    }
    const before = data?.usageRebillingEnabled === true;
    if (before === on) return { changed: false, agencyId };
    tx.update(subRef, {
      usageRebillingEnabled: on,
      ...(on ? { usageRebillingSince: FieldValue.serverTimestamp() } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { changed: true, agencyId };
  });
  if (result.changed) {
    await auditFlip(actorUid, result.agencyId, subAccountId, !on, on);
    // A switch is part of what makes a usage flag valid, so it may lift one.
    await refreshUsageOverdue(subAccountId);
  }
  return { changed: result.changed };
}

/**
 * The agency master switch. Switching it OFF also switches every client of
 * the agency off (one audit row per client that changed), so switching the
 * master back on reactivates nobody.
 */
export async function setAgencyUsageRebilling(
  agencyId: string,
  on: boolean,
  actorUid: string,
): Promise<{ changed: boolean; clientsSwitchedOff: string[] }> {
  const db = getAdminDb();
  const agencyRef = db.doc(`agencies/${agencyId}`);
  const rebilledClients = db
    .collection("subAccounts")
    .where("agencyId", "==", agencyId)
    .where("usageRebillingEnabled", "==", true)
    .limit(REBILLING_CASCADE_CHUNK);

  let changed = false;
  const switchedOff: string[] = [];
  for (let first = true; ; first = false) {
    const step = await db.runTransaction(async (tx) => {
      const agencyOn = (await tx.get(agencyRef)).data()?.usageRebillingEnabled === true;
      // The master went back on mid-cascade: clear nothing (which ends the
      // loop), so a client the owner has just switched on stays on.
      if (!first && agencyOn) return { changed: false, cleared: [] as string[] };
      const clients = on ? [] : (await tx.get(rebilledClients)).docs;
      const flip = first && agencyOn !== on;
      if (flip) {
        tx.update(agencyRef, {
          usageRebillingEnabled: on,
          ...(on ? { usageRebillingSince: FieldValue.serverTimestamp() } : {}),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      for (const c of clients) {
        tx.update(c.ref, {
          usageRebillingEnabled: false,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      return { changed: flip, cleared: clients.map((c) => c.id) };
    });
    // Audited as each commit lands, so a later chunk failing leaves no
    // committed change unaudited; a retry (master already off) clears and
    // audits the stragglers.
    if (first) {
      changed = step.changed;
      if (changed) await auditFlip(actorUid, agencyId, null, !on, on);
    }
    await Promise.all(step.cleared.map((id) => auditFlip(actorUid, agencyId, id, true, false)));
    switchedOff.push(...step.cleared);
    if (step.cleared.length < REBILLING_CASCADE_CHUNK) break;
  }

  // Switched-off clients (and the master itself) can no longer be walled for usage.
  if (changed || switchedOff.length > 0) await refreshAgencyUsageOverdue(agencyId);

  return { changed, clientsSwitchedOff: switchedOff };
}

/**
 * The agency's paywall setting (`agencies/{id}.usagePaywallEnabled`): whether an
 * overdue usage charge may wall a client workspace once the grace period ends.
 * Off, a client only ever sees a banner. Read, flip and audit as one change;
 * flagged clients are re-checked afterwards so a flip takes effect at once.
 */
export async function setAgencyUsagePaywall(
  agencyId: string,
  on: boolean,
  actorUid: string,
): Promise<{ changed: boolean; refreshed: boolean }> {
  const db = getAdminDb();
  const agencyRef = db.doc(`agencies/${agencyId}`);
  const changed = await db.runTransaction(async (tx) => {
    const before = (await tx.get(agencyRef)).data()?.usagePaywallEnabled === true;
    if (before === on) return false;
    tx.update(agencyRef, {
      usagePaywallEnabled: on,
      // Each off-to-on starts a fresh 7 days before anyone is walled.
      ...(on ? { usagePaywallEnabledAt: FieldValue.serverTimestamp() } : {}),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return true;
  });
  if (changed) {
    await recordAuditEvent(db, {
      action: "usage_paywall.updated",
      actor: { type: "user", id: actorUid },
      target: { type: "agency", id: agencyId },
      agencyId,
      subAccountId: null,
      changes: [{ field: "usagePaywallEnabled", before: !on, after: on }],
    });
  }
  // Also when nothing changed: a retry after a failed re-check must be able to finish it.
  const refreshed = await refreshAgencyUsageOverdue(agencyId);
  return { changed, refreshed };
}
