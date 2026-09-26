"use client";

import { createContext, useContext } from "react";
import type { AppTheme } from "@/types";

/**
 * The agency's public branding, read server-side by the dashboard layout
 * (lib/server/agency-branding.ts) so the first paint already shows the
 * agency's name and logo. useAgency seeds from this; its live onSnapshot
 * takes over after mount. appTheme is seeded too, but AppAccent applies it
 * in an effect after hydration — the first paint is still the stock accent.
 */
export interface AgencyBranding {
  name: string | null;
  logoUrl: string | null;
  appTheme: AppTheme | null;
}

const AgencyBrandingContext = createContext<AgencyBranding | null>(null);

export function AgencyBrandingProvider({
  initial,
  children,
}: {
  initial: AgencyBranding | null;
  children: React.ReactNode;
}) {
  return (
    <AgencyBrandingContext.Provider value={initial}>
      {children}
    </AgencyBrandingContext.Provider>
  );
}

/** Null outside the dashboard, or when the server could not read it. */
export function useInitialAgencyBranding(): AgencyBranding | null {
  return useContext(AgencyBrandingContext);
}
