/**
 * The title a contact renders under. WhatsApp-inbound contacts arrive
 * nameless (the bridge webhook writes `name: ""`), so every surface that
 * shows a contact's name falls back to phone, then email, before the
 * "Unnamed" placeholder.
 */
export function contactDisplayName(
  contact: { name?: string | null; phone?: string | null; email?: string | null },
  fallback = "Unnamed"
): string {
  return (
    contact.name?.trim() ||
    contact.phone?.trim() ||
    contact.email?.trim() ||
    fallback
  );
}

/**
 * A contact must be identifiable by at least one of name, phone or email.
 * The one rule behind the contact form, POST /api/contacts and the CSV
 * import, so a nameless WhatsApp contact that the form accepts is never
 * refused by the server.
 */
export function hasContactIdentity(contact: {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
}): boolean {
  return !!(contact.name?.trim() || contact.phone?.trim() || contact.email?.trim());
}

export const CONTACT_IDENTITY_ERROR = "Enter a name, phone or email";
