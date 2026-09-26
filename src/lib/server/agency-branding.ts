import "server-only";

import { cache } from "react";
import { headers } from "next/headers";
import { getAdminDb } from "@/lib/firebase/admin";
import type { AgencyBranding } from "@/context/agency-branding-context";
import type { AppTheme } from "@/types";

/**
 * The signed-in user's agency branding for the dashboard's first paint.
 * `x-agency-id` is set by middleware from the verified token's claim only
 * (any caller-sent value is stripped). One Admin read per request —
 * `cache()` dedupes repeat calls within a render.
 *
 * Fails open: no header, no doc, or any error → null, and the client
 * falls back to its live onSnapshot as before.
 */
export const getInitialAgencyBranding = cache(
  async (): Promise<AgencyBranding | null> => {
    const agencyId = (await headers()).get("x-agency-id");
    if (!agencyId) return null;
    try {
      const snap = await getAdminDb().doc(`agencies/${agencyId}`).get();
      if (!snap.exists) return null;
      const d = snap.data() ?? {};
      return {
        name: typeof d.name === "string" && d.name ? d.name : null,
        logoUrl: typeof d.logoUrl === "string" && d.logoUrl ? d.logoUrl : null,
        appTheme: (d.appTheme as AppTheme | undefined) ?? null,
      };
    } catch (err) {
      console.error("[agency-branding] initial branding read failed", err);
      return null;
    }
  },
);
