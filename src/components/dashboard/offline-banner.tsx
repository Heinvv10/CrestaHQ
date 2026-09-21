"use client";

import { WifiOff } from "lucide-react";
import { useOnlineStatus } from "@/hooks/use-online-status";

/**
 * App-wide: every dashboard page relies on live Firestore listeners with no
 * persistent local cache (see src/lib/firebase/client.ts), so a lost
 * connection leaves the screen showing whatever it last had — silently. This
 * says so, on every page, for as long as the browser reports itself offline.
 */
export function OfflineBanner() {
  const online = useOnlineStatus();
  if (online) return null;
  return (
    <div
      role="status"
      className="flex shrink-0 items-center justify-center gap-2 bg-amber-500/15 px-4 py-2 text-sm font-medium text-amber-800 dark:text-amber-400"
    >
      <WifiOff className="h-4 w-4 shrink-0" />
      You&apos;re offline. What you see here may be out of date.
    </div>
  );
}
