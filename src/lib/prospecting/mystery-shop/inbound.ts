import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { normalizePhoneE164 } from "@/lib/contacts/phone";
import { isDocId } from "@/lib/server/doc-id";
import { callOutcome, callStartedAt, type CallReport } from "./call-match";
import { decideEmail, type InboundEmail } from "./email-match";
import { closableShops, markBounced, recordAutoReply, settleResponded } from "./store";
import { toMs } from "./model";

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
        targetDomainTrusted: s.targetDomainTrusted,
      };
    }),
  );
  // decideEmail closed nothing for a failing sender; an email sender is never provable, so unknown.
  const via = { responseVia: "email", senderAuth: "unknown" } as const;
  for (const [shopId, decision] of decisions) {
    if (decision === "responded") await settleResponded(shopId, message.occurredAtMs, via);
    else if (decision === "auto_reply") await recordAutoReply(shopId, message.occurredAtMs);
    else if (decision === "bounced") await markBounced(shopId);
  }
}

/**
 * The end-of-call report of a mystery-shop call (`metadata.mysteryShopId`).
 * Only the call we placed counts: the report's Vapi call id must be the
 * shop's `providerRef` — a shop id copied into another call's metadata
 * settles nothing. Answered = responded at the answer time. Not answered
 * leaves it waiting for a callback. Another sub-account's shop, or not a
 * call shop, is ignored.
 */
export async function settleMysteryShopCall(
  subAccountId: string,
  shopId: string,
  callId: string,
  report: CallReport,
): Promise<void> {
  if (!isDocId(shopId)) return;
  const shop = (await getAdminDb().doc(`mysteryShops/${shopId}`).get()).data();
  if (!shop || shop.subAccountId !== subAccountId || shop.channel !== "call") return;
  if (!callId || shop.providerRef !== callId) return;
  const outcome = callOutcome(report);
  if (!outcome.answered) return;
  // Vapi's start can precede our sentAt (stamped after the create call returned): never a negative time.
  const atMs = Math.max(outcome.atMs, toMs(shop.sentAt) ?? outcome.atMs);
  await settleResponded(shopId, atMs, { responseVia: "answered", senderAuth: "pass" });
}

/**
 * An inbound call to the sub-account: from a waiting call shop's exact number
 * = a callback, at the call's start. Caller ID can be spoofed and Vapi gives
 * no way to verify it, so it is recorded `senderAuth: "unknown"`.
 */
export async function matchInboundCallback(subAccountId: string, callerPhone: string | null, report: CallReport): Promise<void> {
  const caller = normalizePhoneE164(callerPhone);
  if (!caller) return;
  const docs = (await closableShops(subAccountId, "call")).filter((d) => d.data()?.target === caller);
  const { atMs } = callStartedAt(report);
  for (const d of docs) await settleResponded(d.id, atMs, { responseVia: "callback", senderAuth: "unknown" });
}
