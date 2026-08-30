"use client";

import { useEffect, useState } from "react";
import { subscribeToConversations } from "@/lib/firestore/conversations";
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
  subAccountId: string | null,
): number {
  const { user } = useAuth();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!user || !subAccountId) {
      setCount(0);
      return;
    }
    const unsub = subscribeToConversations(subAccountId, (rows) => {
      setCount(rows.filter((c) => (c.unreadCount ?? 0) > 0).length);
    });
    return () => unsub();
  }, [user, subAccountId]);

  return count;
}
