import "server-only";

import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebase/admin";

/**
 * A "Send AI text" step texts a contact at most once per 30 days, however
 * many workflows or re-entries reach them: an AI cold text is the message
 * most likely to read as spam. `subAccounts/{id}/aiSmsCooldowns/{contactId}`
 * (server-only) holds when the last one went. The step claims it in a
 * transaction just before sending and hands it back if nothing went out.
 */

export const AI_SMS_COOLDOWN_MS = 30 * 86_400_000;

interface CooldownDoc {
  lastSentAtMs?: number;
  /** The run holding the current claim; null once handed back. */
  runId?: string | null;
  /** What `lastSentAtMs` was before this claim, restored by a release. */
  previousAtMs?: number | null;
}

const ref = (subAccountId: string, contactId: string) =>
  getAdminDb().doc(`subAccounts/${subAccountId}/aiSmsCooldowns/${contactId}`);

const active = (d: CooldownDoc | undefined, now: number) =>
  typeof d?.lastSentAtMs === "number" && now - d.lastSentAtMs < AI_SMS_COOLDOWN_MS;

/** True while the contact had an AI text within the last 30 days. */
export async function aiSmsCooldownActive(subAccountId: string, contactId: string): Promise<boolean> {
  return active((await ref(subAccountId, contactId).get()).data() as CooldownDoc | undefined, Date.now());
}

/** Take the contact's cooldown for this run. False = another AI text went within 30 days. */
export async function claimAiSmsCooldown(input: {
  subAccountId: string;
  agencyId: string;
  contactId: string;
  runId: string;
}): Promise<boolean> {
  const db = getAdminDb();
  const docRef = ref(input.subAccountId, input.contactId);
  return db.runTransaction(async (tx) => {
    const now = Date.now();
    const current = (await tx.get(docRef)).data() as CooldownDoc | undefined;
    if (active(current, now)) return false;
    tx.set(docRef, {
      agencyId: input.agencyId,
      subAccountId: input.subAccountId,
      contactId: input.contactId,
      lastSentAtMs: now,
      runId: input.runId,
      previousAtMs: current?.lastSentAtMs ?? null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return true;
  });
}

/** Hand back this run's claim when its text never went out. Never throws:
 *  a claim left behind errs toward not texting the contact. */
export async function releaseAiSmsCooldown(input: {
  subAccountId: string;
  contactId: string;
  runId: string;
}): Promise<void> {
  const db = getAdminDb();
  const docRef = ref(input.subAccountId, input.contactId);
  try {
    await db.runTransaction(async (tx) => {
      const current = (await tx.get(docRef)).data() as CooldownDoc | undefined;
      if (current?.runId !== input.runId) return;
      if (typeof current.previousAtMs === "number") {
        tx.update(docRef, { lastSentAtMs: current.previousAtMs, runId: null, previousAtMs: null });
      } else {
        tx.delete(docRef);
      }
    });
  } catch (err) {
    console.warn(
      `[workflows] AI text cooldown release failed for ${input.contactId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
