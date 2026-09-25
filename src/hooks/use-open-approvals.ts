"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * Agent proposals needing a person (pending + unsettled) in the sub-account,
 * for the sidebar badge. ONE request to the list route per navigation — the
 * route applies the territory rule, which a client listener could not — and
 * nothing at all while the Agent API gate is off.
 */
export function useOpenApprovalsCount(
  subAccountId: string | null,
  enabled: boolean
): number {
  const pathname = usePathname();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!subAccountId || !enabled) {
      setCount(0);
      return;
    }
    let live = true;
    fetch(`/api/sub-accounts/${subAccountId}/agent-proposals?status=open`)
      .then((res) => (res.ok ? res.json() : { proposals: [] }))
      .then((data: { proposals?: unknown[] }) => {
        if (live) setCount(data.proposals?.length ?? 0);
      })
      .catch(() => {
        if (live) setCount(0);
      });
    return () => {
      live = false;
    };
  }, [subAccountId, enabled, pathname]);

  return count;
}
