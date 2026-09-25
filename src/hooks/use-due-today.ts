"use client";

import { useEffect, useState } from "react";
import { subscribeToDueTodayCount } from "@/lib/firestore/tasks";
import { useEffectiveTerritoryFilter } from "@/hooks/use-effective-territory-filter";
import { useAuth } from "@/hooks/use-auth";

/**
 * Number of incomplete tasks due today (or overdue) for the given sub-account.
 * The Sidebar renders this as a badge next to the Tasks nav item.
 *
 * The active sub-account is passed IN (see useActiveSubAccountId) rather than
 * read from context: this hook's consumers (Sidebar / PWA badges) render above
 * the SubAccountProvider, where the context is always null — reading it there
 * silently pinned every badge to `memberships[0]`.
 *
 * The query's "due before tomorrow" bound is fixed when it subscribes, and the
 * Sidebar never remounts, so the hook re-subscribes at local midnight.
 */
export function useDueTodayCount(subAccountId: string | null): number {
  const { user } = useAuth();
  const territory = useEffectiveTerritoryFilter(subAccountId);
  const [count, setCount] = useState(0);
  const [day, setDay] = useState(() => new Date().toDateString());

  useEffect(() => {
    const next = new Date();
    next.setHours(24, 0, 1, 0); // just past the coming local midnight
    const timer = setTimeout(
      () => setDay(new Date().toDateString()),
      next.getTime() - Date.now(),
    );
    return () => clearTimeout(timer);
  }, [day]);

  useEffect(() => {
    if (!user || !subAccountId || !territory.ready) {
      setCount(0);
      return;
    }
    setCount(0);
    const unsub = subscribeToDueTodayCount(
      subAccountId,
      setCount,
      () => setCount(0),
      territory.filter,
    );
    return () => unsub();
  }, [user, subAccountId, territory.ready, territory.filter, day]);

  return count;
}
