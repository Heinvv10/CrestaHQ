"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Copy, Loader2, MapPin } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";

/**
 * Google Business Profile connection card — links this sub-account to the
 * Google account that manages its listings.
 *
 * The OAuth tokens are never rendered (or returned) here: the server stores
 * them in the locked `private/` subcollection and this card reads only
 * `googleConnectionMeta` off the sub-account doc. Same secret-handling model
 * as the Stripe and Webinar1 cards.
 *
 * Admin-only, and self-gating on `googleEnabledByAgency` — renders nothing
 * until the agency owner unlocks it. Reads the `?google=…` status the
 * connect/callback routes redirect back with.
 */

const STATUS_MESSAGES: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "Google Business Profile connected." },
  cancelled: { ok: false, text: "Connection cancelled." },
  bad_state: {
    ok: false,
    text: "Connection failed a security check. Try again.",
  },
  not_configured: {
    ok: false,
    text: "Google isn't configured on this deployment yet (missing OAuth client credentials).",
  },
  gate_off: { ok: false, text: "This feature is locked by your agency." },
  no_refresh_token: {
    ok: false,
    text: "Google didn't return a long-lived token. Remove this app at myaccount.google.com → Security → Third-party access, then connect again.",
  },
  error: { ok: false, text: "Couldn't connect to Google. Please try again." },
};

export function SubAccountGoogleSection() {
  const { subAccountId, subAccount, isAdmin } = useSubAccount();
  const meta = subAccount?.googleConnectionMeta ?? null;
  const connected = !!meta?.connected;
  const [disconnecting, setDisconnecting] = useState(false);

  // Surface the ?google=… status the connect/callback routes redirect back
  // with, then strip it from the URL so a refresh doesn't re-toast.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const status = params.get("google");
    if (!status) return;
    const msg = STATUS_MESSAGES[status];
    if (msg) {
      if (msg.ok) toast.success(msg.text);
      else toast.error(msg.text);
    }
    params.delete("google");
    const qs = params.toString();
    window.history.replaceState(
      {},
      "",
      `${window.location.pathname}${qs ? `?${qs}` : ""}`,
    );
  }, []);

  if (!isAdmin) return null;
  if (subAccount?.googleEnabledByAgency !== true) return null;

  // ONE redirect URI for the whole deployment — registered once in the Google
  // Cloud console, never per sub-account. The connecting sub-account travels
  // in the signed OAuth `state`. Must mirror googleRedirectUri() on the server.
  const redirectUri = `${window.location.origin}/api/google/callback`;

  function handleConnect() {
    // Full-page nav so the OAuth redirect chain works.
    window.location.href = `/api/sub-accounts/${subAccountId}/google/connect`;
  }

  async function handleDisconnect() {
    if (
      !confirm(
        "Disconnect Google Business Profile for this sub-account? The access is revoked at Google; you can reconnect anytime.",
      )
    ) {
      return;
    }
    setDisconnecting(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/google`, {
        method: "DELETE",
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Failed to disconnect.");
      }
      toast.success("Google Business Profile disconnected.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to disconnect.");
    } finally {
      setDisconnecting(false);
    }
  }

  function copy(value: string, label: string) {
    void navigator.clipboard.writeText(value);
    toast.success(`${label} copied.`);
  }

  return (
    <section className="rounded-2xl border bg-card p-6">
      <header className="mb-4 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400">
          <MapPin className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">Google Business Profile</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Connect the Google account that manages this business&apos;s
            listings. You&apos;ll be sent to Google to authorise access.
          </p>
        </div>
      </header>

      {connected ? (
        <div className="rounded-lg border bg-background p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <p className="flex items-center gap-2 text-sm font-medium">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                {meta?.email || "Google account connected"}
              </p>
              <p className="text-xs text-muted-foreground">
                Business Profile management access granted.
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleConnect}
                title="Re-authorise (refreshes the token + permissions)"
              >
                Reconnect
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disconnecting}
                onClick={handleDisconnect}
              >
                {disconnecting ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : null}
                Disconnect
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border bg-background p-4">
          <p className="text-sm font-medium">Not connected</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Sign in with the Google account that owns or manages the Business
            Profile for this workspace.
          </p>
          <div className="mt-3">
            <Button type="button" size="sm" onClick={handleConnect}>
              Connect Google Business Profile
            </Button>
          </div>
        </div>
      )}

      {/* Setup reference — the URI the agency registers in Google Cloud. */}
      <div className="mt-4 rounded-lg border bg-muted/30 p-3 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">
          Google Cloud setup (one-time)
        </p>
        <p className="mt-1">
          The agency registers this redirect URI on the OAuth client{" "}
          <strong>once for the whole deployment</strong> — it&apos;s the same
          for every sub-account, so new clients connect with no extra Google
          setup.
        </p>
        <div className="mt-2 flex items-center gap-2">
          <code className="flex-1 truncate rounded bg-background px-2 py-1.5 text-[11px]">
            {redirectUri}
          </code>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => copy(redirectUri, "Redirect URI")}
          >
            <Copy className="mr-1 h-3 w-3" />
            Copy
          </Button>
        </div>
      </div>
    </section>
  );
}
