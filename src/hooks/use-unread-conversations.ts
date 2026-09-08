"use client";

import { useEffect, useState } from "react";
import { subscribeToConversations } from "@/lib/firestore/conversations";
import { useEffectiveTerritoryFilter } from "@/hooks/use-effective-territory-filter";
import { useAuth } from "@/hooks/use-auth";

/**
 * Number of conversations with unread inbound messages for the given
 * sub-account. Rendered as a badge in the Sidebar, PWA bottom tab bar and the
 * installed app's OS icon.
 *
 * The active sub-account is passed IN (see useActiveSubAccountId) rather than
 * read from context: every consumer renders above the SubAccountProvider, where
 * the context is always null — reading it there silently pinned every badge to
 * `memberships[0]`.
 */
export function useUnreadConversationsCount(
  subAccountId: string | null
): number {
  const { user } = useAuth();
  const territory = useEffectiveTerritoryFilter(subAccountId);
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!user || !subAccountId || !territory.ready) {
      setCount(0);
      return;
    }
    setCount(0);
    const unsub = subscribeToConversations(
      subAccountId,
      (rows) => {
        setCount(rows.filter((c) => (c.unreadCount ?? 0) > 0).length);
      },
      () => setCount(0),
      territory.filter
    );
    return () => unsub();
  }, [user, subAccountId, territory.ready, territory.filter]);

  return count;
}
