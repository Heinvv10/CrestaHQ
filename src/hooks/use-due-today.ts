"use client";

import { useEffect, useState } from "react";
import { subscribeToTasks } from "@/lib/firestore/tasks";
import { toDate } from "@/lib/format";
import { useAuth } from "@/hooks/use-auth";

/**
 * Number of incomplete tasks due today (or overdue) for the given sub-account.
 * The Sidebar renders this as a badge next to the Tasks nav item.
 *
 * The active sub-account is passed IN (see useActiveSubAccountId) rather than
 * read from context: this hook's consumers (Sidebar / PWA badges) render above
 * the SubAccountProvider, where the context is always null — reading it there
 * silently pinned every badge to `memberships[0]`.
 */
export function useDueTodayCount(
  subAccountId: string | null,
  agencyId: string | null,
): number {
  const { user } = useAuth();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!user || !subAccountId || !agencyId) {
      setCount(0);
      return;
    }
    const unsub = subscribeToTasks(
      { agencyId, subAccountId },
      (tasks) => {
        const now = Date.now();
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const nextDay = new Date(today);
        nextDay.setDate(nextDay.getDate() + 1);
        let n = 0;
        for (const t of tasks) {
          if (t.completed) continue;
          const d = toDate(t.dueAt);
          if (!d) continue;
          // overdue or due today
          if (d.getTime() < nextDay.getTime() || d.getTime() < now) {
            n += 1;
          }
        }
        setCount(n);
      },
    );
    return () => unsub();
  }, [user, subAccountId, agencyId]);

  return count;
}
