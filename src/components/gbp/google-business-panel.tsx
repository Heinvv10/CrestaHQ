"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Loader2, Lock, MapPin } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import type { GoogleListing } from "@/types/google";
import { ExtraListings } from "./extra-listings";
import { InlineConfirm } from "./inline-confirm";
import { ListingPicker } from "./listing-picker";
import { ReviewUrlCard } from "./review-url-card";
import { ReviewsSection } from "./reviews-section";
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

/** A mutating call whose outcome is a toast; the live doc updates the view. */
async function send(url: string, method: string, okText: string): Promise<void> {
  const res = await fetch(url, { method }).catch(() => null);
  const data = (await res?.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
  if (res?.ok && data?.ok) toast.success(okText);
  else toast.error(data?.error ?? "That didn't work. Please try again.");
}

type Configured = "loading" | "yes" | "no" | "unknown";

/** Is Google usable on this deployment? Asked once per sub-account. */
export function useGoogleConfigured(subAccountId: string, ask: boolean): Configured {
  const [state, setState] = useState<{ id: string; value: Configured } | null>(null);
  useEffect(() => {
    if (!ask) return;
    let live = true;
    void (async () => {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/google/status`).catch(() => null);
      const data = (await res?.json().catch(() => null)) as { configured?: boolean } | null;
      // Unknown (network/server trouble) does not block the page: the connect
      // route still refuses with ?google=not_configured if it has to.
      const value: Configured =
        typeof data?.configured === "boolean" ? (data.configured ? "yes" : "no") : "unknown";
      if (live) setState({ id: subAccountId, value });
    })();
    return () => {
      live = false;
    };
  }, [subAccountId, ask]);
  return state?.id === subAccountId ? state.value : "loading";
}

export function GoogleBusinessPanel() {
  const { subAccountId, subAccount, isAdmin, loading } = useSubAccount();
  const [changing, setChanging] = useState(false);
  useGoogleStatusToast();
  const gateOn = subAccount?.googleEnabledByAgency === true;
  const configured = useGoogleConfigured(subAccountId, !loading && gateOn && isAdmin);
  const api = `/api/sub-accounts/${subAccountId}/google`;

  const connectHref = `${api}/connect?return=gbp`;
  // Full-page navigation: the OAuth redirect chain needs a real page load.
  const connect = () => {
    window.location.href = connectHref;
  };

  // Disconnect must stay reachable wherever the rest of the flow cannot run
  // (gate off, deployment not configured) — the API always permits it.
  const disconnect = (
    <div className="mt-3">
      <InlineConfirm
        label="Disconnect Google"
        confirmLabel="Yes, disconnect"
        prompt="Revoke access at Google and remove this connection?"
        onConfirm={() => send(api, "DELETE", "Google Business Profile disconnected.")}
      />
    </div>
  );

  if (loading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="gbp-state-loading">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </p>
    );
  }

  if (!gateOn) {
    return (
      <Shell testId="gbp-state-gate-locked">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Lock className="h-4 w-4" /> This feature is locked by your agency.
        </p>
        {/* Disconnect stays available with the gate off (the API allows it),
            so a connection is never stranded. */}
        {isAdmin && subAccount?.googleConnectionMeta?.connected && disconnect}
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
        {listing && (subAccount.googleExtraListings?.length ?? 0) > 0 && (
          <ExtraListings subAccountId={subAccountId} main={listing.locationName} extras={subAccount.googleExtraListings ?? []} canEdit={false} />
        )}
        {/* Members may read the synced reviews; only admins sync. */}
        {listing && meta?.connected && (
          <ReviewsSection subAccountId={subAccountId} canSync={false} reconnect={!!meta.reconnectRequired} />
        )}
      </Shell>
    );
  }

  if (configured === "loading") {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="gbp-state-loading">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </p>
    );
  }

  if (configured === "no") {
    return (
      <Shell testId="gbp-state-not-configured">
        <p className="text-sm font-medium">Not configured on this deployment</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Google Business Profile needs the deployment&apos;s Google OAuth client
          (set up by whoever runs this app).{" "}
          {meta?.connected
            ? "The existing connection can't be used until then, but you can still disconnect it."
            : "Nothing can be connected until then."}
        </p>
        {/* Connect / Reconnect / the picker cannot work here; Disconnect can. */}
        {meta?.connected && disconnect}
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
        {/* Cached reviews stay visible — labelled as such — until reconnected. */}
        {listing && <ReviewsSection subAccountId={subAccountId} canSync={false} reconnect />}
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
      <ExtraListings subAccountId={subAccountId} main={listing.locationName} extras={subAccount.googleExtraListings ?? []} canEdit />
      <ReviewUrlCard />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => setChanging(true)} data-testid="gbp-change-listing">
          Change listing
        </Button>
        <InlineConfirm
          label="Stop managing this listing"
          confirmLabel="Yes, stop managing"
          prompt="Clear the selected listing? Google stays connected."
          onConfirm={() => send(`${api}/listing`, "DELETE", "Listing cleared.")}
          testId="gbp-clear-listing"
        />
      </div>
      <ReviewsSection subAccountId={subAccountId} canSync reconnect={false} />
    </Shell>
  );
}
