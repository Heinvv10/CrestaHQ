"use client";

import Link from "next/link";
import { Loader2, Lock } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { useGoogleConfigured } from "@/components/gbp/google-business-panel";
import { ReviewsSection } from "@/components/gbp/reviews-section";
import { WidgetSection } from "@/components/gbp/widget-section";
import { SubAccountGoogleReviewSection } from "@/components/settings/sub-account-google-review-section";

/**
 * Reputation → Reviews and → Widgets mount the existing Google Business
 * components as they are — same data fetching, same routes. Connecting
 * Google and choosing the listing stay on AI Agents → Google Business; these
 * panels only say so when that has not happened, instead of a failed fetch.
 */

function Note({ testId, children }: { testId: string; children: React.ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed p-6 text-sm text-muted-foreground" data-testid={testId}>
      {children}
    </p>
  );
}

function Loading({ testId }: { testId: string }) {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid={testId}>
      <Loader2 className="h-4 w-4 animate-spin" /> Loading…
    </p>
  );
}

const locked = (
  <span className="flex items-center gap-2"><Lock className="h-4 w-4" /> Google reviews are not enabled for this sub-account.</span>
);

export function ReputationReviews() {
  const { subAccountId, subAccount, isAdmin, loading } = useSubAccount();
  // Sync and reply need the deployment's Google OAuth client — asked for admins only, as on the Google Business page.
  const configured = useGoogleConfigured(subAccountId, !loading && subAccount?.googleEnabledByAgency === true && isAdmin);
  if (loading || !subAccount) return <Loading testId="rep-reviews-loading" />;
  if (subAccount.googleEnabledByAgency !== true) return <Note testId="rep-reviews-gate-off">{locked}</Note>;
  const meta = subAccount.googleConnectionMeta ?? null;
  if (!meta?.connected || !subAccount.googleListing) {
    return (
      <Note testId="rep-reviews-setup">
        Connect Google Business Profile and choose the listing in{" "}
        <Link href={`/sa/${subAccountId}/ai-agents/google-business`} className="font-medium text-foreground underline-offset-2 hover:underline">
          AI Agents → Google Business
        </Link>{" "}
        to see reviews here.
      </Note>
    );
  }
  if (isAdmin && configured === "loading") return <Loading testId="rep-reviews-loading" />;
  const reconnect = meta.reconnectRequired === true;
  // Members read; admins also sync and reply — never offered when the deployment cannot do either.
  // "unknown" (the check itself failed) does not block, as on the Google Business page; the routes still refuse.
  return (
    <>
      {configured === "no" && (
        <Note testId="rep-reviews-not-configured">
          Google isn&apos;t configured on this deployment, so reviews can&apos;t be synced or replied to here. The reviews already synced are shown.
        </Note>
      )}
      <ReviewsSection subAccountId={subAccountId} canSync={isAdmin && !reconnect && configured !== "no"} reconnect={reconnect} />
    </>
  );
}

export function ReputationWidgets() {
  const { subAccount, isAdmin, loading } = useSubAccount();
  if (loading || !subAccount) return <Loading testId="rep-widgets-loading" />;
  if (!isAdmin) return <Note testId="rep-widgets-not-admin">Only sub-account admins manage the reviews widget.</Note>;
  // WidgetSection shows Revoke with the gate off when a widget exists; with none, there is nothing to do.
  if (subAccount.googleEnabledByAgency !== true && !subAccount.gbpWidgetMeta) {
    return <Note testId="rep-widgets-gate-off">{locked}</Note>;
  }
  return (
    <div data-testid="rep-widgets">
      <WidgetSection />
    </div>
  );
}

/** Reputation → Settings: the review-request settings (link, channel, message, triggers, reminders), admins only. */
export function ReputationSettings() {
  const { subAccount, isAdmin, loading } = useSubAccount();
  if (loading || !subAccount) return <Loading testId="rep-settings-loading" />;
  if (!isAdmin) return <Note testId="rep-settings-not-admin">Only sub-account admins change review-request settings.</Note>;
  return (
    <div data-testid="rep-settings">
      <SubAccountGoogleReviewSection />
    </div>
  );
}
