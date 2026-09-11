"use client";

import { useSubAccount } from "@/context/sub-account-context";
import { useSubAccountMembers } from "@/hooks/use-sub-account-members";

export const SELECT_CLASS =
  "border-input text-foreground focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-input/30 [&_option]:bg-background [&_option]:text-foreground flex h-8 w-full rounded-lg border bg-transparent px-2.5 text-sm transition-colors outline-none focus-visible:ring-3";

/**
 * "Assigned to" picker shared by the contact form, deal dialogs, task
 * dialog and the bulk-assign dialog. Lists the sub-account's active
 * members; the empty option is Unassigned (stored as null).
 */
export function AssigneeSelect({
  id,
  value,
  onChange,
  className,
}: {
  id: string;
  value: string | null | undefined;
  onChange: (uid: string | null) => void;
  className?: string;
}) {
  const { subAccountId } = useSubAccount();
  const { members } = useSubAccountMembers(subAccountId);
  // Keep a stored assignee visible even if they have since left the roster.
  const stale = value && !members.some((m) => m.uid === value);
  return (
    <select
      id={id}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
      className={className ?? SELECT_CLASS}
    >
      <option value="">Unassigned</option>
      {members.map((m) => (
        <option key={m.uid} value={m.uid}>
          {m.displayName}
        </option>
      ))}
      {stale && <option value={value}>Former member</option>}
    </select>
  );
}
