"use client";

import { useEffect } from "react";
import { useUnreadConversationsCount } from "@/hooks/use-unread-conversations";
import { useActiveSubAccountId } from "@/hooks/use-active-sub-account-id";

/**
 * Mirrors the unread-conversations count onto the installed app's icon via
 * the Badging API (Android/desktop Chromium, iOS 17+ home-screen PWAs).
 * Renders nothing; silently no-ops where the API doesn't exist. Cleared on
 * unmount (sign-out unmounts the dashboard layout) so a badge can't
 * outlive the session that set it.
 */
export function AppBadge() {
  const { subAccountId } = useActiveSubAccountId();
  const unread = useUnreadConversationsCount(subAccountId);

  useEffect(() => {
    const nav = navigator as Navigator & {
      setAppBadge?: (n?: number) => Promise<void>;
      clearAppBadge?: () => Promise<void>;
    };
    if (!nav.setAppBadge || !nav.clearAppBadge) return;
    if (unread > 0) {
      void nav.setAppBadge(unread).catch(() => {});
    } else {
      void nav.clearAppBadge().catch(() => {});
    }
    return () => {
      void nav.clearAppBadge?.().catch(() => {});
    };
  }, [unread]);

  return null;
}
