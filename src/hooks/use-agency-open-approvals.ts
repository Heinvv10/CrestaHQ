"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

/**
 * Agency-key proposals needing the agency owner, for the sidebar's Agency →
 * Approvals entry + badge: ONE request to the agency list route per
 * navigation. `mode` as useOpenApprovalsCount: "open" while the agency's
 * Agent API switch is on, "unsettled" while it is off (those still need
 * settling), null to not ask (not an owner, or still loading).
 */
export function useAgencyOpenApprovalsCount(mode: "open" | "unsettled" | null): number {
  const pathname = usePathname();
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!mode) {
      setCount(0);
      return;
    }
    let live = true;
    fetch(`/api/agency/agent-proposals?status=${mode}`)
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
  }, [mode, pathname]);

  return count;
}
