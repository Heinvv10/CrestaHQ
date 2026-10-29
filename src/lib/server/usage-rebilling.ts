import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";
import { recordAuditEvent } from "@/lib/audit/record";

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
    if (first) changed = step.changed;
    switchedOff.push(...step.cleared);
    if (step.cleared.length < REBILLING_CASCADE_CHUNK) break;
  }

  if (changed) await auditFlip(actorUid, agencyId, null, !on, on);
  await Promise.all(switchedOff.map((id) => auditFlip(actorUid, agencyId, id, true, false)));
  return { changed, clientsSwitchedOff: switchedOff };
}
