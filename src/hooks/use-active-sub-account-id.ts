"use client";

import { usePathname } from "next/navigation";
import { useAuth } from "@/hooks/use-auth";

/**
 * Resolves the active sub-account for components that render ABOVE the
 * SubAccountProvider. The Sidebar, PWA bottom tab bar, PWA app-icon badge and
 * the Cmd+K command palette all mount in `(dashboard)/layout.tsx` — one level
 * up from where `SubAccountProvider` wraps (`/sa/[subAccountId]/layout.tsx`).
 * From there `useOptionalSubAccount()` is ALWAYS null, so anything relying on it
 * silently falls back to `memberships[0]` and shows/searches the wrong
 * sub-account regardless of which one is actually open.
 *
 * Instead we derive the id from the URL — `/sa/[subAccountId]/...` — the same
 * pattern the Sidebar already uses for nav highlighting, with a `memberships[0]`
 * fallback ONLY on agency-level pages where there's genuinely no active
 * sub-account. `agencyId` comes from the matching membership (falling back to
 * the auth claim; v1 is one agency per deployment).
 */
export function useActiveSubAccountId(): {
  subAccountId: string | null;
  agencyId: string | null;
} {
  const pathname = usePathname();
  const { memberships, agencyId: claimAgencyId } = useAuth();

  const fromPath = pathname.match(/^\/sa\/([^/]+)/)?.[1] ?? null;
  const subAccountId = fromPath ?? memberships[0]?.subAccountId ?? null;
  const membership =
    memberships.find((m) => m.subAccountId === subAccountId) ?? null;
  const agencyId =
    membership?.agencyId ?? claimAgencyId ?? memberships[0]?.agencyId ?? null;

  return { subAccountId, agencyId };
}
