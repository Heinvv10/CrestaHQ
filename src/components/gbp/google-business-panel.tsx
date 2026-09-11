"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Lock, MapPin } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import type { GoogleListing } from "@/types/google";
import { ListingPicker } from "./listing-picker";
import { useGoogleStatusToast } from "./use-google-status-toast";

/**
 * The Google Business page: connect the Google account that manages the
 * business's Business Profile, then choose which listing this sub-account
 * manages. Every state renders a stable `data-testid` so the E2E suite can
 * assert which one it is looking at.
 *
 * State comes from the live sub-account doc (`googleEnabledByAgency`,
 * `googleConnectionMeta`, `googleListing`) — display data only; tokens never
 * reach the browser. No confirm()/alert(): they freeze browser automation.
 */

function Shell({ testId, children }: { testId: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border bg-card p-6" data-testid={testId}>
      <header className="mb-4 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400">
          <MapPin className="h-4 w-4" />
        </span>
        <div>
          <h1 className="text-base font-semibold">Google Business Profile</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Connect the Google account that manages this business&apos;s
            Business Profile and choose the listing to manage.
          </p>
        </div>
      </header>
      {children}
    </section>
  );
}

function ListingSummary({ listing }: { listing: GoogleListing }) {
  return (
    <div className="space-y-0.5 text-sm" data-testid="gbp-selected-listing">
      <p className="font-medium">{listing.title}</p>
      <p className="text-muted-foreground">{listing.address || "No storefront address"}</p>
      {listing.websiteUri && <p className="text-xs text-muted-foreground">{listing.websiteUri}</p>}
      {listing.placeId && <p className="text-xs text-muted-foreground">Place ID: {listing.placeId}</p>}
    </div>
  );
}

export function GoogleBusinessPanel() {
  const { subAccountId, subAccount, isAdmin, loading } = useSubAccount();
  const [changing, setChanging] = useState(false);
  useGoogleStatusToast();

  const connectHref = `/api/sub-accounts/${subAccountId}/google/connect?return=gbp`;
  // Full-page navigation: the OAuth redirect chain needs a real page load.
  const connect = () => {
    window.location.href = connectHref;
  };

  if (loading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="gbp-state-loading">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </p>
    );
  }

  if (subAccount?.googleEnabledByAgency !== true) {
    return (
      <Shell testId="gbp-state-gate-locked">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Lock className="h-4 w-4" /> This feature is locked by your agency.
        </p>
      </Shell>
    );
  }

  const meta = subAccount.googleConnectionMeta ?? null;
  const listing = subAccount.googleListing ?? null;

  if (!isAdmin) {
    return (
      <Shell testId="gbp-state-not-admin">
        <p className="text-sm text-muted-foreground">
          Only sub-account admins can connect Google or change the listing.
        </p>
        {listing && <div className="mt-3"><ListingSummary listing={listing} /></div>}
      </Shell>
    );
  }

  if (!meta?.connected) {
    return (
      <Shell testId="gbp-state-disconnected">
        <p className="text-sm font-medium">Not connected</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          You&apos;ll be sent to Google to sign in with the account that owns
          or manages the Business Profile.
        </p>
        <Button type="button" size="sm" className="mt-3" onClick={connect} data-testid="gbp-connect">
          Connect Google Business Profile
        </Button>
      </Shell>
    );
  }

  if (meta.reconnectRequired) {
    return (
      <Shell testId="gbp-state-reconnect">
        <p className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
          <AlertTriangle className="h-4 w-4" /> Google no longer accepts this connection
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {meta.reconnectReason === "insufficient_scope"
            ? "The Business Profile permission was not granted. Reconnect and leave it ticked on Google's consent screen."
            : "Access was revoked or expired at Google. Reconnect with the Google account that manages this listing."}
        </p>
        <Button type="button" size="sm" className="mt-3" onClick={connect} data-testid="gbp-reconnect">
          Reconnect
        </Button>
      </Shell>
    );
  }

  if (!listing || changing) {
    return (
      <Shell testId="gbp-state-pick">
        <p className="mb-3 text-sm font-medium">Choose the listing this workspace manages</p>
        <ListingPicker
          subAccountId={subAccountId}
          onClose={listing ? () => setChanging(false) : undefined}
        />
      </Shell>
    );
  }

  return (
    <Shell testId="gbp-state-selected">
      <p className="mb-2 flex items-center gap-2 text-sm font-medium">
        <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" /> Managing this listing
      </p>
      <ListingSummary listing={listing} />
      <Button type="button" size="sm" variant="outline" className="mt-3" onClick={() => setChanging(true)} data-testid="gbp-change-listing">
        Change listing
      </Button>
    </Shell>
  );
}
