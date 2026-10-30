import "server-only";

import type { DocumentReference } from "firebase-admin/firestore";

import { getAdminDb } from "@/lib/firebase/admin";

/**
 * One reminder text per event per half hour. Two reminders of an event that
 * fire together (a held 720-minute one released at 06:00 and the 60-minute one
 * firing at 06:00) are the same message twice. Each reminder text takes
 * `events/{id}/reminderSends/smsrecent_{tokenHash}` first:
 *
 *   - free (none, or older than RECENT_MS): taken, state `sending`;
 *   - `sent` by another offset inside RECENT_MS: this one collapses onto it;
 *   - `sending` by another offset: it may still fail (then this one must send),
 *     so this one is told to try again (`in_flight`, a 503 for QStash). On QStash's
 *     last delivery the lock is taken over ONLY IF the holder's own claim (its
 *     path is stored in the lock) does not exist, which proves the holder never
 *     reserved and nothing went out (it crashed first). If the claim exists, a
 *     reserve happened and the outcome is unknown (a hung carrier call, a crash
 *     after the send), so this one collapses and sends nothing;
 *   - this offset's own, `sending`: a crashed attempt or a twin delivery of this
 *     very step, taken over; the per-offset claim in sendBookingSms keeps the
 *     send exactly-once either way;
 *   - this offset's own, `sent`: a redelivery.
 *
 * A step marks it `sent` after a text went and deletes it when none did, so
 * another reminder can still go.
 */

export const RECENT_TEXT_MS = 30 * 60_000;

export type TextLock =
  | { ok: true; at: number; mine: boolean; release: () => Promise<void>; markSent: () => Promise<void> }
  /** `collapsed`: another offset's text covers this one; `at` is when it started, `outcome` whether it is known to have gone. */
  | { ok: false; reason: "already_sent"; collapsed: boolean; at: number; outcome: "sent" | "unknown" }
  | { ok: false; reason: "in_flight"; collapsed: false }
  /** The last delivery lost the takeover race: the caller notes it (nothing will retry). */
  | { ok: false; reason: "lock_contended"; collapsed: false };

const code = (err: unknown) => (err as { code?: unknown } | null)?.code;
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function takeTextLock(input: {
  eventId: string;
  tokenKey: string;
  agencyId: string;
  subAccountId: string;
  offsetMinutes: number;
  /** This text's per-offset claim doc, stored in the lock so another offset can tell whether this one ever reserved. */
  claimPath: string;
  /** The per-offset claim doc exists: this offset's own text was claimed already. */
  ownClaimExists: () => Promise<boolean>;
  finalAttempt: boolean;
  now?: number;
}): Promise<TextLock> {
  const db = getAdminDb();
  const ref = db.doc(`events/${input.eventId}/reminderSends/smsrecent_${input.tokenKey}`);
  const now = input.now ?? Date.now();
  const fresh = (at: number) => ({
    agencyId: input.agencyId,
    subAccountId: input.subAccountId,
    offsetMinutes: input.offsetMinutes,
    state: "sending",
    claimPath: input.claimPath,
    at,
  });

  const lock = (at: number, mine: boolean): TextLock => ({
    ok: true,
    at,
    mine,
    release: () => releaseLock(ref, input.offsetMinutes, at),
    markSent: () => markSent(ref, input.offsetMinutes, at),
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await ref.create(fresh(now));
      return lock(now, false);
    } catch (err) {
      if (code(err) !== 6) throw err;
    }
    const snap = await ref.get();
    if (!snap.exists) continue; // given back between our create and read
    const cur = snap.data() as { offsetMinutes?: number; state?: string; at?: number; claimPath?: string };
    const at = typeof cur.at === "number" ? cur.at : 0;
    const mine = cur.offsetMinutes === input.offsetMinutes;

    if (now - at < RECENT_TEXT_MS) {
      if (cur.state === "sent") return { ok: false, reason: "already_sent", collapsed: !mine, at, outcome: "sent" };
      // `sending`
      if (mine) {
        // Our own claim exists: it is a delivery of this very text, which the claim answers.
        if (await input.ownClaimExists()) return lock(at, true);
      } else if (!input.finalAttempt) {
        return { ok: false, reason: "in_flight", collapsed: false };
      } else if (typeof cur.claimPath !== "string" || (await db.doc(cur.claimPath).get()).exists) {
        // The holder reserved (or we cannot tell): whether its text went is unknown, so no second one.
        return { ok: false, reason: "already_sent", collapsed: true, at, outcome: "unknown" };
      }
    }
    // Stale, a crashed attempt of this offset, or (last delivery) a holder gone silent: take over.
    const took = await db
      .runTransaction(async (tx) => {
        const again = await tx.get(ref);
        const data = again.data() as { at?: number; state?: string; offsetMinutes?: number } | undefined;
        if (!again.exists || data?.at !== cur.at || data?.state !== cur.state || data?.offsetMinutes !== cur.offsetMinutes) return false;
        tx.set(ref, fresh(now));
        return true;
      })
      .catch((err: unknown) => {
        console.warn("[events/reminder] text lock takeover failed", message(err));
        return false;
      });
    if (took) return lock(now, false);
    // Another step changed the lock first. Retry later, unless this is the last delivery.
    return input.finalAttempt ? { ok: false, reason: "lock_contended", collapsed: false } : { ok: false, reason: "in_flight", collapsed: false };
  }
  return input.finalAttempt ? { ok: false, reason: "lock_contended", collapsed: false } : { ok: false, reason: "in_flight", collapsed: false };
}

async function markSent(ref: DocumentReference, offsetMinutes: number, at: number): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // A plain write (not a transaction): we hold the lock, and a text has gone.
      await ref.set({ state: "sent", offsetMinutes, at }, { merge: true });
      return;
    } catch (err) {
      console.warn("[events/reminder] text lock mark-sent failed", attempt, message(err));
    }
  }
}

/** Gives the lock back (nothing went out), only if it is still ours. */
async function releaseLock(ref: DocumentReference, offsetMinutes: number, at: number): Promise<void> {
  try {
    await getAdminDb().runTransaction(async (tx) => {
      const data = (await tx.get(ref)).data() as { at?: number; offsetMinutes?: number } | undefined;
      if (data?.at === at && data.offsetMinutes === offsetMinutes) tx.delete(ref);
    });
  } catch (err) {
    console.error("[events/reminder] text lock release failed", message(err));
  }
}
