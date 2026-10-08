import "server-only";

import { MailboxError } from "@/lib/comms/imap";
import { matchMysteryShopEmail } from "@/lib/prospecting/mystery-shop/inbound";
import type { InboundEmail } from "@/lib/prospecting/mystery-shop/email-match";
import type { MailboxConnection } from "@/types/mailbox";

/** Consecutive passes the same message may fail matching before it is passed. */
export const MAX_MATCH_FAILURES = 3;

/**
 * Hand an inbound message to the mystery-shop reply matcher. A failure fails
 * the sync pass, so the cursor stays before the message and the next pass
 * re-reads it — unless the SAME message (folder, UIDVALIDITY, uid) has now
 * failed MAX_MATCH_FAILURES passes in a row: then it is logged, recorded on
 * the connection (`matchSkipped`) and passed, so one message can never stall
 * the mailbox import. A skipped message cannot close a shop, and a miss that
 * follows still needs a member's confirmation before it is public. Mutates
 * `connection.matchFailure` / `matchSkipped`; the sync's checkpoint saves them.
 */
export async function matchOrSkip(
  subAccountId: string,
  connection: MailboxConnection,
  at: { folder: string; uidValidity: string; uid: number },
  message: InboundEmail,
): Promise<void> {
  try {
    await matchMysteryShopEmail(subAccountId, message);
  } catch (err) {
    const prev = connection.matchFailure;
    const same = prev?.folder === at.folder && prev.uidValidity === at.uidValidity && prev.uid === at.uid;
    const count = same ? prev.count + 1 : 1;
    if (count >= MAX_MATCH_FAILURES) {
      console.error("[mailbox-sync] reply matching keeps failing; skipping the message", subAccountId, at, err);
      connection.matchFailure = null;
      connection.matchSkipped = { ...at, at: new Date().toISOString() };
      return;
    }
    console.error("[mailbox-sync] mystery-shop match failed", subAccountId, err);
    connection.matchFailure = { ...at, count };
    throw new MailboxError("Reply matching failed. Retry sync.", 502);
  }
}
