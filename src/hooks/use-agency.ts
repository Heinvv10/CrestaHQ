"use client";

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { useAuth } from "@/hooks/use-auth";
import { useInitialAgencyBranding } from "@/context/agency-branding-context";
import { getFirebaseDb } from "@/lib/firebase/client";
import { CUSTOM_BRAND } from "@/config/landing";
import type { AgencyDoc, AppTheme } from "@/types";

interface AgencySummary {
  /** Agency display name. Falls back to the deployment brand until hydrated. */
  name: string;
  /** Optional logo URL — when set, sidebar swaps the LeadStack chevron mark for this. */
  logoUrl: string | null;
  /**
   * Public report brand colour (`#RRGGBB`). Null until set in Agency →
   * Settings; drives `/report/[shareId]`, never the dashboard chrome.
   */
  brandColor: string | null;
  /** Public support / contact email. Null until set in Agency → Settings. */
  supportEmail: string | null;
  /** Bare public domain (no scheme). Null until set in Agency → Settings. */
  primaryDomain: string | null;
  /** Dashboard accent theme. Null = deployment-mode default. */
  appTheme: AppTheme | null;
  /**
   * Agency Assistant master switch (Agency → Settings). OFF by default —
   * only an explicit `true` on the doc enables it; legacy/unset reads off.
   * Drives the sidebar entry + the /agency/ai-suite page state.
   */
  agencyAssistantEnabled: boolean;
  /**
   * Model tier the Agency Assistant runs on. Unset/legacy docs read as
   * "opus" — matches pre-picker behavior for upgrading deployments.
   */
  agencyAssistantModel: "opus" | "sonnet";
  /** Agency Agent API kill switch; only an explicit `true` reads on. */
  agentApiEnabled: boolean;
  /**
   * Starts as `!!agencyId` at mount and flips false when the snapshot (or
   * its error) arrives. On a hard load auth has not resolved at mount, so
   * it starts — and stays — false even before the doc arrives; only a
   * mount after auth has settled sees it true. Server-seeded branding does
   * NOT flip it. Brand chrome should gate on `brandingReady` instead.
   */
  loading: boolean;
  /**
   * True once name/logoUrl/appTheme are the agency's real values: seeded by
   * the server (AgencyBrandingProvider), delivered by the snapshot, or known
   * to be absent (auth settled with no agency). Brand chrome gates on this.
   * appTheme is still applied by AppAccent's effect after hydration, so a
   * seed does not remove the accent-theme swap on first paint.
   */
  brandingReady: boolean;
}

interface AgencyData {
  name: string;
  logoUrl: string | null;
  brandColor: string | null;
  supportEmail: string | null;
  primaryDomain: string | null;
  appTheme: AppTheme | null;
  agencyAssistantEnabled: boolean;
  agencyAssistantModel: "opus" | "sonnet";
  agentApiEnabled: boolean;
}

/**
 * Live subscription to the current agency doc — drives the dashboard chrome
 * (sidebar logo + wordmark, browser tab title) AND hydrates the Agency →
 * Settings branding form. Returns sensible defaults before hydration so
 * SSR matches the first client paint.
 */
export function useAgency(): AgencySummary {
  const { agencyId, loading: authLoading } = useAuth();
  // Same value on the server render and the client's first render, so
  // seeding cannot cause a hydration mismatch.
  const seed = useInitialAgencyBranding();
  const [resolved, setResolved] = useState(false);
  const [data, setData] = useState<AgencyData>({
    // Deployment brand, not the template name — this fallback surfaces in
    // client-visible chrome (sidebar wordmark, header title) pre-hydration.
    name: seed?.name || CUSTOM_BRAND.name,
    logoUrl: seed?.logoUrl ?? null,
    brandColor: null,
    supportEmail: null,
    primaryDomain: null,
    appTheme: seed?.appTheme ?? null,
    agencyAssistantEnabled: false,
    agencyAssistantModel: "opus",
    agentApiEnabled: false,
  });
  const [loading, setLoading] = useState<boolean>(!!agencyId);

  useEffect(() => {
    if (!agencyId) {
      setLoading(false);
      return;
    }
    const ref = doc(getFirebaseDb(), `agencies/${agencyId}`);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (snap.exists()) {
          const d = snap.data() as Partial<AgencyDoc>;
          setData({
            name: (d.name as string) || CUSTOM_BRAND.name,
            logoUrl: (d.logoUrl as string | null) ?? null,
            brandColor: (d.brandColor as string | null) ?? null,
            supportEmail: (d.supportEmail as string | null) ?? null,
            primaryDomain: (d.primaryDomain as string | null) ?? null,
            appTheme: (d.appTheme as AppTheme | null) ?? null,
            agencyAssistantEnabled: d.agencyAssistantEnabled === true,
            agencyAssistantModel:
              d.agencyAssistantModel === "sonnet" ? "sonnet" : "opus",
            agentApiEnabled: d.agentApiEnabled === true,
          });
        }
        setLoading(false);
        setResolved(true);
      },
      () => {
        setLoading(false);
        setResolved(true);
      },
    );
    return () => unsub();
  }, [agencyId]);

  const brandingReady = !!seed || resolved || (!authLoading && !agencyId);
  return { ...data, loading, brandingReady };
}
