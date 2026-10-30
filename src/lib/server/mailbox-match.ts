import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { MailboxError } from "@/lib/comms/imap";
import { matchMysteryShopEmail } from "@/lib/prospecting/mystery-shop/inbound";
import type { InboundEmail } from "@/lib/prospecting/mystery-shop/email-match";
import type { MailboxConnection } from "@/types/mailbox";

/** Consecutive passes the same message may fail matching before it is passed. */
export const MAX_MATCH_FAILURES = 3;
/** A matcher that hangs is a failure — well inside the sync's 90 s lease. */
export const MATCH_TIMEOUT_MS = 20_000;

type At = { folder: string; uidValidity: string; uid: number };
type Failure = At & { count: number };

const sameMessage = (f: Failure | null | undefined, at: At): f is Failure =>
  !!f && f.folder === at.folder && f.uidValidity === at.uidValidity && f.uid === at.uid;

/**
 * Update the connection's match bookkeeping in its own transaction that checks
 * only that the connection settings are unchanged (its `version`) — not the
 * sync lease, so a slow matcher that outlived the lease still advances the count.
 */
async function saveMatchState(
  subAccountId: string,
  version: string,
  fields: (current: Failure | null | undefined) => Record<string, unknown> | null,
): Promise<void> {
  const db = getAdminDb();
  const ref = db.doc(`subAccounts/${subAccountId}/private/mailboxConnection`);
  await db.runTransaction(async (tx) => {
    const live = (await tx.get(ref)).data() as MailboxConnection | undefined;
    if (live?.version !== version) return;
    const update = fields(live.matchFailure);
    if (update) tx.update(ref, update);
  });
}

function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Reply matching timed out.")), MATCH_TIMEOUT_MS);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Hand an inbound message to the mystery-shop reply matcher. A failure (or a
 * matcher hanging past MATCH_TIMEOUT_MS) fails the sync pass, so the cursor
 * stays before the message and the next pass re-reads it — unless the SAME
 * message (folder, UIDVALIDITY, uid) has now failed MAX_MATCH_FAILURES passes
 * in a row: then it is logged, recorded on the connection (`matchSkipped`) and
 * passed, so one message can never stall the mailbox import. A skipped
 * message cannot close a shop, and a miss that follows still needs a member's
 * confirmation before it is public. A success clears that message's record.
 */
export async function matchOrSkip(
  subAccountId: string,
  connection: MailboxConnection,
  at: At,
  message: InboundEmail,
): Promise<void> {
  try {
    await withTimeout(matchMysteryShopEmail(subAccountId, message, connection.ownAddresses));
  } catch (err) {
    let skip = false;
    await saveMatchState(subAccountId, connection.version, (current) => {
      const count = sameMessage(current, at) ? current.count + 1 : 1;
      skip = count >= MAX_MATCH_FAILURES;
      return skip ? { matchFailure: null, matchSkipped: { ...at, at: new Date().toISOString() } } : { matchFailure: { ...at, count } };
    }).catch((e) => console.error("[mailbox-sync] match failure count not saved", subAccountId, e));
    if (skip) {
      console.error("[mailbox-sync] reply matching keeps failing; skipping the message", subAccountId, at, err);
      return;
    }
    console.error("[mailbox-sync] mystery-shop match failed", subAccountId, err);
    throw new MailboxError("Reply matching failed. Retry sync.", 502);
  }
  await saveMatchState(subAccountId, connection.version, (current) => (sameMessage(current, at) ? { matchFailure: null } : null)).catch(
    (e) => console.error("[mailbox-sync] match failure record not cleared", subAccountId, e),
  );
}
