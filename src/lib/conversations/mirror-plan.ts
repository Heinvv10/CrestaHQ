/**
 * Pure planning for the conversation owner/email mirror (SP2 T1/I9). No
 * imports, so the backfill script can load it under
 * `node --experimental-strip-types` without the `@/` alias or server-only.
 * The writers live in lib/server/conversation-mirror.ts.
 */

/** The contact fields the conversation mirrors. */
export interface ConversationMirror {
  assigneeUid: string | null;
  contactEmail: string | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Mirror values for a contact document (or null when there is no contact). */
export function contactMirror(
  contact: Record<string, unknown> | null | undefined
): ConversationMirror {
  return {
    assigneeUid: str(contact?.assignedToUid),
    contactEmail: str(contact?.email),
  };
}

/**
 * The patch that would bring one conversation's mirror in line with its
 * contact, or null when it is already correct. Pure — shared by the backfill
 * script (scripts/backfill-conversation-owner-email.ts) and its tests.
 *
 * A conversation whose contact is missing or belongs to another tenant is
 * reported as orphaned and never patched: clearing the mirror there would
 * silently unassign a thread over a transient read, and writing a foreign
 * contact's owner would leak across tenants.
 */
export function planConversationMirror(
  conversation: Record<string, unknown>,
  contact: Record<string, unknown> | null | undefined
): { patch: ConversationMirror | null; orphaned: boolean } {
  const contactId = conversation.contactId;
  // An anonymous web-chat row has no contact to mirror — not an orphan.
  if (contactId === null || contactId === undefined)
    return { patch: null, orphaned: false };
  if (
    !contact ||
    contact.subAccountId !== conversation.subAccountId ||
    contact.agencyId !== conversation.agencyId
  )
    return { patch: null, orphaned: true };
  const mirror = contactMirror(contact);
  const current = {
    assigneeUid: (conversation.assigneeUid as string | null) ?? null,
    contactEmail: (conversation.contactEmail as string | null) ?? null,
  };
  const same =
    current.assigneeUid === mirror.assigneeUid &&
    current.contactEmail === mirror.contactEmail;
  return { patch: same ? null : mirror, orphaned: false };
}
