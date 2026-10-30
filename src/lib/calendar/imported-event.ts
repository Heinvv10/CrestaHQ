import type { AssignableMember } from "@/types";

/**
 * Whose Google Calendar an imported event came from. The doc stores only the
 * owner's uid (no name is denormalised onto it), so the roster supplies the
 * name; `null` when the member has since left, or has no display name (the
 * roster then falls back to an email, which is not shown to teammates).
 */
export function importedOwnerName(
  members: Pick<AssignableMember, "uid" | "displayName">[],
  ownerUid: string | null | undefined,
): string | null {
  if (!ownerUid) return null;
  const name = members.find((m) => m.uid === ownerUid)?.displayName.trim();
  return name && !name.includes("@") ? name : null;
}
