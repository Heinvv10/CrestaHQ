"use client";

import { useEffect, useState } from "react";
import { useOnlineStatus } from "@/hooks/use-online-status";

/** Still loading after this long, with the browser online: say so. */
export const SLOW_AFTER_MS = 10_000;

/**
 * Why a list may not be arriving. "offline" only when the browser reports
 * it; otherwise "slow" after SLOW_AFTER_MS — the cause (a blocked Firestore
 * connection, a slow network) is not known, so the copy does not name one.
 * Mount it per load (key it) so the timer measures the current one.
 */
export function useLoadingHint(): "offline" | "slow" | null {
  const online = useOnlineStatus();
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    const timer = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);
  if (!online) return "offline";
  return slow ? "slow" : null;
}
