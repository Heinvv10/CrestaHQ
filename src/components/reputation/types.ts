import type { Overview } from "@/lib/reputation/overview";
import type { GbpHealth } from "@/lib/gbp/sync/types";

/** GET /api/sub-accounts/[id]/reputation/overview — what the page reads. */
export interface OverviewResponse extends Overview {
  reviewsUnavailable: "gate_off" | "not_connected" | "no_listing" | null;
  listing: { averageRating: number | null; totalReviewCount: number | null } | null;
  health: GbpHealth | null;
  lastSuccessfulSyncAt: string | null;
  lastErrorKind: string | null;
  lastReconciliation: string | null;
  truncated: { reviews: boolean; requests: boolean };
  reviewsAi: {
    enabled: boolean;
    configured: boolean;
    /** A classification holds the lease right now. */
    running: boolean;
    lastRun: { classified: number; skipped: number; failed: number; at: string | null } | null;
  };
  checklist: {
    googleConnected: boolean;
    listingSelected: boolean;
    reviewLinkConfigured: boolean;
    widgetExists: boolean;
    requestLogged: boolean;
  };
}
