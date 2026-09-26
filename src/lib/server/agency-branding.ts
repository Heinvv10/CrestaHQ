import "server-only";

import { cache } from "react";
import { headers } from "next/headers";
import { getAdminDb } from "@/lib/firebase/admin";
import type { AgencyBranding } from "@/context/agency-branding-context";
import type { AppTheme } from "@/types";

// Cross-request TTL cache per agency id, like isLicenseRevoked's. Only
// successful reads are cached, so a failure is retried on the next request.
const CACHE_MS = 60 * 1000;
const cached = new Map<string, { value: AgencyBranding | null; at: number }>();

/**
 * The signed-in user's agency branding for the dashboard's first paint.
 * `x-agency-id` is set by middleware from the verified token's claim only
 * (any caller-sent value is stripped). At most one Admin read per agency
 * per 60 s; `cache()` also dedupes repeat calls within a render.
 *
 * Fails open: no header, no doc, or any error → null, and the client
 * falls back to its live onSnapshot as before.
 */
export const getInitialAgencyBranding = cache(
  async (): Promise<AgencyBranding | null> => {
    const agencyId = (await headers()).get("x-agency-id");
    if (!agencyId) return null;
    const hit = cached.get(agencyId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    try {
      const snap = await getAdminDb().doc(`agencies/${agencyId}`).get();
      const d = snap.exists ? (snap.data() ?? {}) : null;
      const value: AgencyBranding | null = d && {
        name: typeof d.name === "string" && d.name ? d.name : null,
        logoUrl: typeof d.logoUrl === "string" && d.logoUrl ? d.logoUrl : null,
        appTheme: (d.appTheme as AppTheme | undefined) ?? null,
      };
      cached.set(agencyId, { value, at: Date.now() });
      return value;
    } catch (err) {
      console.error("[agency-branding] initial branding read failed", err);
      return null;
    }
  },
);
