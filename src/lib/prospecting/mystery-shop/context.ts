import "server-only";

import { createHash } from "node:crypto";
import { getAdminDb } from "@/lib/firebase/admin";
import { publishCallback } from "@/lib/automations/qstash";
import type { ContactProspecting, SubAccountDoc } from "@/types";
import type { Contact } from "@/types/contacts";
import { enquiryVars, renderEnquiries } from "./enquiry";

/**
 * What the mystery-shop route needs about a contact, its enquiry and its
 * timer, kept out of the route so it stays readable.
 */

export type ShopContact = Contact & { prospecting?: ContactProspecting; website?: string };

/** The contact, when it exists in this sub-account; else null (the route's 404). */
export async function loadContact(subAccountId: string, contactId: string): Promise<ShopContact | null> {
  const snap = await getAdminDb().doc(`contacts/${contactId}`).get();
  const data = snap.data();
  return snap.exists && data?.subAccountId === subAccountId ? ({ ...data, id: snap.id } as ShopContact) : null;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * The enquiry as rendered for this contact now: the email (subject + body) and
 * call texts exactly as stored on a shop, and a hash of each. The dialog echoes
 * the hash of the text it showed; a POST whose hash differs (the templates or
 * the contact changed meanwhile) is refused, so what is sent is what was seen.
 */
export function enquiryOf(contact: ShopContact, sub: SubAccountDoc) {
  const rendered = renderEnquiries(sub.prospectingMysteryShopTemplates, enquiryVars(contact, sub.name));
  const text = { email: `${rendered.email.subject}\n\n${rendered.email.body}`, call: rendered.call };
  return { ...rendered, text, hash: { email: sha256(text.email), call: sha256(text.call) } };
}

export const TIMER_PATH = "/api/automations/prospecting/mystery-shop";

/** Queue the shop's timer. A failed publish is recorded on the shop; the GET sweep is the backstop. */
export async function queueTimer(shopId: string, delaySeconds: number, deduplicationId: string): Promise<boolean> {
  const timer = await publishCallback({ pathname: TIMER_PATH, body: { shopId }, delaySeconds, deduplicationId });
  if (timer) return true;
  await getAdminDb()
    .doc(`mysteryShops/${shopId}`)
    .update({ timerError: "The 24 h timer could not be queued." })
    .catch((err) => console.error("[prospecting/mystery-shop] timerError write failed", shopId, err));
  return false;
}
