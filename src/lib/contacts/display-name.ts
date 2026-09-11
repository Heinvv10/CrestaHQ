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
