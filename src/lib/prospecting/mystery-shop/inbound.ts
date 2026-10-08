import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { normalizePhoneE164 } from "@/lib/contacts/phone";
import { callOutcome, callStartedAt, type CallReport } from "./call-match";
import { decideEmail, type InboundEmail } from "./email-match";
import { closableShops, recordAutoReply, settleResponded } from "./store";

/**
 * The inbound hooks: one call from each host path (IMAP mailbox sync, the
 * Vapi end-of-call webhook). Each only settles shops of the sub-account the
 * host path is already scoped to. The hosts wrap these so a failure here is
 * logged and never breaks them.
 */

/** An inbound email in `subAccountId`'s mailbox, at its own arrival time. */
export async function matchMysteryShopEmail(subAccountId: string, message: InboundEmail): Promise<void> {
  const docs = await closableShops(subAccountId, "email");
  if (!docs.length) return;
  const decisions = decideEmail(
    message,
    docs.map((d) => {
      const s = d.data() ?? {};
      return {
        id: d.id,
        target: String(s.target ?? ""),
        status: s.status,
        sentAt: s.sentAt,
        respondedAt: s.respondedAt,
        autoReplyAt: s.autoReplyAt,
        providerRef: s.providerRef,
      };
    }),
  );
  for (const [shopId, decision] of decisions) {
    if (decision === "responded") await settleResponded(shopId, message.occurredAtMs);
    else if (decision === "auto_reply") await recordAutoReply(shopId, message.occurredAtMs);
  }
}

/**
 * The end-of-call report of a mystery-shop call (`metadata.mysteryShopId`).
 * Answered = responded at the answer time. Not answered leaves it waiting for
 * a callback. A shop of another sub-account, or not a call, is ignored.
 */
export async function settleMysteryShopCall(subAccountId: string, shopId: string, report: CallReport): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(shopId)) return;
  const shop = (await getAdminDb().doc(`mysteryShops/${shopId}`).get()).data();
  if (!shop || shop.subAccountId !== subAccountId || shop.channel !== "call") return;
  const outcome = callOutcome(report);
  if (outcome.answered) await settleResponded(shopId, outcome.atMs);
}

/** An inbound call to the sub-account: from a waiting call shop's exact number = a callback, at the call's start. */
export async function matchInboundCallback(subAccountId: string, callerPhone: string | null, report: CallReport): Promise<void> {
  const caller = normalizePhoneE164(callerPhone);
  if (!caller) return;
  const docs = (await closableShops(subAccountId, "call")).filter((d) => d.data()?.target === caller);
  const { atMs } = callStartedAt(report);
  for (const d of docs) await settleResponded(d.id, atMs);
}
