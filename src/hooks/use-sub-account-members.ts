"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { AssignableMember } from "@/types";

/**
 * The assignee roster for the current sub-account, from
 * GET /api/sub-accounts/[id]/members. The last successful roster per
 * sub-account is kept for the session so a failed refetch (offline, 5xx)
 * still shows names; the failure itself is toasted rather than swallowed —
 * a picker that silently offers only "Unassigned" reads as "nobody else
 * exists".
 */
const lastKnown = new Map<string, AssignableMember[]>();

export function useSubAccountMembers(subAccountId: string | null | undefined) {
  const [members, setMembers] = useState<AssignableMember[]>(
    () => (subAccountId && lastKnown.get(subAccountId)) || [],
  );

  useEffect(() => {
    if (!subAccountId) return;
    let cancelled = false;
    fetch(`/api/sub-accounts/${subAccountId}/members`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`members ${res.status}`);
        return (await res.json()) as { members: AssignableMember[] };
      })
      .then((b) => {
        lastKnown.set(subAccountId, b.members);
        if (!cancelled) setMembers(b.members);
      })
      .catch(() => {
        if (!cancelled) toast.error("Couldn't load the team list.");
      });
    return () => {
      cancelled = true;
    };
  }, [subAccountId]);

  return { members };
}
