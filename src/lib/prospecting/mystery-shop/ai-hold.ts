import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { normalizePhoneE164 } from "@/lib/contacts/phone";
import type { SubAccountDoc } from "@/types";
import { LATE_REPLY_HORIZON_MS, toMs } from "./model";

/**
 * Must our WhatsApp AI stay quiet for this inbound? Yes when the sender's
 * number (whichever contact it landed on — an inbound can auto-create a
 * duplicate) or the contact itself has a WhatsApp mystery shop sent (or being
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
  const snaps = await Promise.all([
    shops.where("contactId", "==", contactId).get(),
    ...(from ? [shops.where("target", "==", from).get()] : []),
  ]);
  return snaps
    .flatMap((s) => s.docs)
    .some((d) => {
      const at = toMs(d.data()?.sentAt) ?? toMs(d.data()?.createdAt);
      return at !== null && nowMs - at <= LATE_REPLY_HORIZON_MS;
    });
}
