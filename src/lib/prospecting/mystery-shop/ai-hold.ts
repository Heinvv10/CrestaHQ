import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { normalizePhoneE164 } from "@/lib/contacts/phone";
import type { SubAccountDoc } from "@/types";
import { LATE_REPLY_HORIZON_MS, toMs } from "./model";
import { senderMatches } from "./email-match";

/**
 * Must our WhatsApp AI stay quiet for this inbound? Yes when the sender's
 * number (whichever contact it landed on — an inbound can auto-create a
 * duplicate) or the contact itself has a WhatsApp mystery shop — or a form
 * shop, by its contact or one of the contact's numbers — sent (or being
 * sent) within LATE_REPLY_HORIZON_MS, in any status: a business we
 * mystery-shopped must never get a bot's answer, and the reply that settled
 * the shop is held too. Checked by maybeRespondWithAi for every WhatsApp
 * rail. Nothing to check while Prospecting is off (no shop can be sent).
 * Throws on a Firestore error; the caller fails closed.
 */
export async function mysteryShopHoldsAi(
  sub: Pick<SubAccountDoc, "prospectingEnabledByAgency">,
  subAccountId: string,
  contactId: string,
  fromPhone: string,
  nowMs = Date.now(),
): Promise<boolean> {
  if (sub.prospectingEnabledByAgency !== true) return false;
  const from = normalizePhoneE164(fromPhone);
  const shops = getAdminDb()
    .collection("mysteryShops")
    .where("subAccountId", "==", subAccountId)
    .where("channel", "==", "whatsapp");
  // Form shops (PR 5c): the business may WhatsApp the number the form gave it, from any of its contact's numbers.
  const forms = getAdminDb().collection("mysteryShops").where("subAccountId", "==", subAccountId).where("channel", "==", "form");
  const snaps = await Promise.all([
    shops.where("contactId", "==", contactId).get(),
    ...(from ? [shops.where("target", "==", from).get()] : []),
    forms.get(),
  ]);
  const ours = (d: FirebaseFirestore.QueryDocumentSnapshot) => {
    const shop = d.data() ?? {};
    if (shop.channel !== "form") return true;
    const numbers: unknown[] = Array.isArray(shop.matchNumbers) ? shop.matchNumbers : [];
    return shop.contactId === contactId || (from !== null && numbers.includes(from));
  };
  return snaps
    .flatMap((s) => s.docs)
    .filter(ours)
    .some((d) => {
      const at = toMs(d.data()?.sentAt) ?? toMs(d.data()?.createdAt);
      return at !== null && nowMs - at <= LATE_REPLY_HORIZON_MS;
    });
}

/**
 * The Email AI twin of mysteryShopHoldsAi: must it stay quiet (write no
 * draft) for this inbound email? Yes when an email or form shop of this
 * sub-account, sent (or being sent) within LATE_REPLY_HORIZON_MS, belongs to
 * this contact or has the sender in its target set — the target address (and
 * its domain when trusted), or a form shop's senders. A draft is never sent
 * by itself, but approving one would answer a business we mystery-shopped.
 * Throws on a Firestore error; the caller fails closed.
 */
export async function mysteryShopHoldsEmailAi(
  sub: Pick<SubAccountDoc, "prospectingEnabledByAgency">,
  subAccountId: string,
  contactId: string,
  fromEmail: string,
  nowMs = Date.now(),
): Promise<boolean> {
  if (sub.prospectingEnabledByAgency !== true) return false;
  const from = fromEmail.trim().toLowerCase();
  const domain = from.slice(from.lastIndexOf("@") + 1);
  const shops = (channel: "email" | "form") =>
    getAdminDb()
      .collection("mysteryShops")
      .where("subAccountId", "==", subAccountId)
      .where("channel", "==", channel)
      .get();
  const snaps = await Promise.all([shops("email"), shops("form")]);
  const lower = (list: unknown): string[] =>
    Array.isArray(list) ? list.map((v) => String(v).toLowerCase()) : [];
  return snaps
    .flatMap((s) => s.docs)
    .some((d) => {
      const shop = d.data() ?? {};
      const at = toMs(shop.sentAt) ?? toMs(shop.createdAt);
      if (at === null || nowMs - at > LATE_REPLY_HORIZON_MS) return false;
      if (shop.contactId === contactId) return true;
      if (shop.channel === "email") {
        return (
          typeof shop.target === "string" &&
          senderMatches(from, shop.target, shop.targetDomainTrusted === true)
        );
      }
      return (
        lower(shop.senders?.addresses).includes(from) ||
        lower(shop.senders?.domains).includes(domain)
      );
    });
}
