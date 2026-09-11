"use client";

import { useEffect, useState } from "react";
import type { AssignableMember } from "@/types";

/**
 * The assignee roster for the current sub-account, from
 * GET /api/sub-accounts/[id]/members. Fetched once per mount — memberships
 * change rarely and every picker re-mounts with its dialog.
 */
export function useSubAccountMembers(subAccountId: string | null | undefined) {
  const [members, setMembers] = useState<AssignableMember[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!subAccountId) return;
    let cancelled = false;
    fetch(`/api/sub-accounts/${subAccountId}/members`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`members ${res.status}`);
        return (await res.json()) as { members: AssignableMember[] };
      })
      .then((b) => {
        if (!cancelled) setMembers(b.members);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "failed");
      });
    return () => {
      cancelled = true;
    };
  }, [subAccountId]);

  return { members, error };
}
