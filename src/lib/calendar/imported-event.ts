import type { AssignableMember } from "@/types";

/**
 * Whose Google Calendar an imported event came from. The doc stores only the
 * owner's uid (no name is denormalised onto it), so the roster supplies the
 * name; `null` when the member has since left.
 */
export function importedOwnerName(
  members: Pick<AssignableMember, "uid" | "displayName">[],
  ownerUid: string | null | undefined,
): string | null {
  if (!ownerUid) return null;
  return members.find((m) => m.uid === ownerUid)?.displayName.trim() || null;
}
