import "server-only";

import { getAdminDb } from "@/lib/firebase/admin";
import { isDocId } from "@/lib/server/doc-id";
import type { Contact } from "@/types/contacts";
import { isImportedEvent } from "@/types/events";

/**
 * Whether a doc id taken from request input names a doc in the caller's
 * sub-account (and, when given, the API key's mode — mode-less events
 * excepted). Routes that link a
 * contact/deal/event by id must check this before writing: membership of
 * the ROUTE's sub-account says nothing about the doc the id points at.
 * Callers answer `false` with a 404, never a 403, so a foreign id is
 * indistinguishable from a missing one.
 */
export async function refInSubAccount(
  collection: "contacts" | "deals" | "events",
  id: string,
  subAccountId: string,
  mode?: string,
): Promise<boolean> {
  if (!isDocId(id)) return false;
  const snap = await getAdminDb().collection(collection).doc(id).get();
  if (!snap.exists) return false;
  const data = snap.data() ?? {};
  if (data.subAccountId !== subAccountId) return false;
  // An imported Google event is never visible to an API key or agent.
  if (mode !== undefined && collection === "events" && isImportedEvent(data)) return false;
  if (mode === undefined || data.mode === mode) return true;
  // Events ONLY: booking-page and voice bookings are written without a
  // `mode`, and are still this sub-account's events. Deliberately, a test-mode
  // key may therefore link a (live) mode-less booking event. Contacts and
  // deals always carry a mode, so no exception is extended to them.
  return collection === "events" && data.mode == null;
}

/**
 * An event's linked contact, or null when unset, missing, or outside the
 * event's sub-account. Every booking side effect (emails, activity rows)
 * loads the contact through this: a legacy event may still hold a contact id
 * from another tenant, and it must read as "no contact".
 */
export async function loadEventContact(event: {
  contactId?: string | null;
  subAccountId: string;
}): Promise<Contact | null> {
  if (!event.contactId || event.contactId.includes("/")) return null;
  const snap = await getAdminDb().collection("contacts").doc(event.contactId).get();
  const data = snap.data();
  if (!snap.exists || data?.subAccountId !== event.subAccountId) return null;
  return { id: snap.id, ...data } as Contact;
}
