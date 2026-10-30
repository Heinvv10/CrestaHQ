"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * Agent proposals needing a person, for the sidebar entry + badge. ONE
 * request to the list route per navigation — the route applies the territory
 * rule, which a client listener could not. `mode`:
 *   - "open": pending + unsettled (the Agent API gate is on);
 *   - "unsettled": only rows whose outcome is unknown (the gate is off: they
 *     still need a person to settle them);
 *   - null: don't ask (the gate is still loading).
 */
export function useOpenApprovalsCount(
  subAccountId: string | null,
  mode: "open" | "unsettled" | null
): number {
  const pathname = usePathname();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!subAccountId || !mode) {
      setCount(0);
      return;
    }
    let live = true;
    fetch(`/api/sub-accounts/${subAccountId}/agent-proposals?status=${mode}`)
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
  }, [subAccountId, mode, pathname]);

  return count;
}
