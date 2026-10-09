import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { normalizePhoneE164 } from "@/lib/contacts/phone";
import { isDocId } from "@/lib/server/doc-id";
import { callOutcome, callStartedAt, type CallReport } from "./call-match";
import { decideEmail, senderAuthenticated, type InboundEmail } from "./email-match";
import {
  closableShops,
  markBounced,
  markUndeliverable,
  recordAuthFailedReply,
  recordAutoReply,
  recordOptOut,
  settleResponded,
  stampDelivery,
} from "./replies";
import { toMs } from "./model";
import { isContentMessage, isWhatsAppAutoReply } from "./whatsapp-match";

/**
 * The inbound hooks: one call from each host path (IMAP mailbox sync, the
 * Vapi end-of-call webhook, the WhatsApp Cloud webhook). Each only settles shops of the sub-account the
 * host path is already scoped to. The hosts wrap these so a failure here is
 * logged and never breaks them.
 */

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** An inbound email in `subAccountId`'s mailbox, at its own arrival time. A form shop is matched against its senders set. */
export async function matchMysteryShopEmail(subAccountId: string, message: InboundEmail): Promise<void> {
  const docs = (await Promise.all([closableShops(subAccountId, "email"), closableShops(subAccountId, "form")])).flat();
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
        ...(s.channel === "form" ? { senders: { addresses: strings(s.matchAddresses), domains: strings(s.matchDomains) } } : {}),
      };
    }),
  );
  // An email sender is never provable (unknown). One the mail host's checks FAILED does not settle
  // the shop — a spoof must not block the genuine reply — it is only noted (authFailedReplyAt).
  const failed = senderAuthenticated(message.authResults, message.from.slice(message.from.lastIndexOf("@") + 1)) === "fail";
  for (const [shopId, decision] of decisions) {
    if (decision === "responded" && failed) await recordAuthFailedReply(shopId, message.occurredAtMs);
    else if (decision === "responded") await settleResponded(shopId, message.occurredAtMs, { responseVia: "email", senderAuth: "unknown" });
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
 * An inbound call to the sub-account: from a waiting call shop's exact number,
 * or one of a waiting form shop's contact numbers (`matchNumbers`), = a
 * callback, at the call's start. Caller ID can be spoofed and Vapi gives
 * no way to verify it, so it is recorded `senderAuth: "unknown"`.
 */
export async function matchInboundCallback(subAccountId: string, callerPhone: string | null, report: CallReport): Promise<void> {
  const caller = normalizePhoneE164(callerPhone);
  if (!caller) return;
  const [calls, forms] = await Promise.all([closableShops(subAccountId, "call"), closableShops(subAccountId, "form")]);
  const docs = [
    ...calls.filter((d) => d.data()?.target === caller),
    ...forms.filter((d) => strings(d.data()?.matchNumbers).includes(caller)),
  ];
  const { atMs } = callStartedAt(report);
  for (const d of docs) await settleResponded(d.id, atMs, { responseVia: "callback", senderAuth: "unknown" });
}

/** One inbound WhatsApp, as the Cloud webhook parsed it. */
export interface InboundWhatsApp {
  /** The sender, E.164. */
  from: string;
  /** Meta's own timestamp. */
  atMs: number;
  text: string;
  /** Meta's message type. */
  type: string;
  /** A STOP (true) or START (false) keyword; null for anything else. */
  optOut: boolean | null;
}

/**
 * A shop with no receipt of its own: the thread row the delivery-status
 * writer keeps (what settleMissed trusts). Delivered/read there = delivered,
 * at an unknown time — the row keeps none — so the send time stands in.
 */
async function rowDelivered(shop: FirebaseFirestore.DocumentData): Promise<number | null> {
  if (typeof shop.providerRef !== "string" || !shop.providerRef || typeof shop.contactId !== "string") return null;
  const row = (await getAdminDb().doc(`contacts/${shop.contactId}/whatsappMessages/${shop.providerRef}`).get()).data();
  return row?.status === "delivered" || row?.status === "read" ? toMs(shop.sentAt) : null;
}

/**
 * A WhatsApp message in to `subAccountId`'s Cloud number: from a waiting
 * WhatsApp shop's exact number = its response, or only an automatic reply
 * (whatsapp-match.ts). Only a content message counts; STOP is recorded on the
 * shop as an opt-out, START is ignored. Any other number, sub-account or
 * channel never settles it. Returns how many shops it changed.
 */
export async function matchMysteryShopWhatsApp(subAccountId: string, msg: InboundWhatsApp): Promise<number> {
  const from = normalizePhoneE164(msg.from);
  if (!from || !isContentMessage(msg.type, msg.text) || msg.optOut === false) return 0;
  const docs = (await closableShops(subAccountId, "whatsapp")).filter((d) => d.data()?.target === from);
  let changed = 0;
  for (const d of docs) {
    // From the later of the send and the delivery receipt (a greeting fires on delivery);
    // before any receipt, automatic.
    const shop = d.data() ?? {};
    const delivered = toMs(shop.deliveredAt) ?? toMs(shop.readAt) ?? (await rowDelivered(shop));
    const elapsed = delivered === null ? 0 : msg.atMs - Math.max(delivered, toMs(shop.sentAt) ?? delivered);
    const done = msg.optOut
      ? await recordOptOut(d.id, msg.atMs)
      : isWhatsAppAutoReply(msg.text, elapsed)
        ? await recordAutoReply(d.id, msg.atMs)
        : await settleResponded(d.id, msg.atMs, { responseVia: "whatsapp", senderAuth: "pass" });
    if (done) changed++;
  }
  return changed;
}

/**
 * A Cloud delivery receipt for one of `subAccountId`'s WhatsApp shops, matched
 * on our message id (`providerRef`): failed = undeliverable, delivered / read
 * stamped for the card.
 */
export async function recordMysteryShopWhatsAppStatus(
  subAccountId: string,
  providerMessageId: string,
  status: "sent" | "delivered" | "read" | "failed",
  atMs: number,
  errorDetail: string | null,
): Promise<void> {
  if (!providerMessageId || status === "sent") return;
  const snap = await getAdminDb()
    .collection("mysteryShops")
    .where("subAccountId", "==", subAccountId)
    .where("channel", "==", "whatsapp")
    .where("providerRef", "==", providerMessageId)
    .get();
  for (const d of snap.docs) {
    if (status === "failed") await markUndeliverable(d.id, errorDetail);
    else await stampDelivery(d.id, status === "delivered" ? "deliveredAt" : "readAt", atMs);
  }
}
