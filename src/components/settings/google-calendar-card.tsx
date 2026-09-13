"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";

/**
 * The signed-in member's own Google Calendar connection (SP3 G1/G4), inside
 * Settings → Calendar sync. Self-gating on `googleCalendarEnabledByAgency`:
 * while the gate is off it renders only a Disconnect for a connection the
 * member still has stored, and nothing otherwise.
 * Reads only what GET /api/sub-accounts/[id]/google-calendar returns for the
 * caller — never a token, never a colleague's connection.
 */

interface Status {
  gateOff?: boolean;
  configured?: boolean;
  connected: boolean;
  status?: "connected" | "revoked" | null;
  googleEmail: string | null;
  lastError?: string | null;
  lastPushError?: string | null;
}

/** The `?gcal=…` statuses the connect/callback routes redirect back with. */
const GCAL_STATUS: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "Google Calendar connected." },
  cancelled: { ok: false, text: "Google Calendar connection cancelled." },
  bad_state: { ok: false, text: "Connection failed a security check. Try again." },
  not_configured: { ok: false, text: "Google isn't configured on this deployment yet." },
  gate_off: { ok: false, text: "Google Calendar sync is locked by your agency." },
  no_refresh_token: {
    ok: false,
    text: "Google didn't return a long-lived token. Remove this app at myaccount.google.com → Security → Third-party access, then connect again.",
  },
  insufficient_scope: {
    ok: false,
    text: "Google didn't grant calendar access. Connect again and leave the calendar permission ticked.",
  },
  error: { ok: false, text: "Couldn't connect to Google Calendar. Please try again." },
};

function useGcalStatusToast(): void {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get("gcal");
    if (!status) return;
    const msg = GCAL_STATUS[status];
    // Deferred one task so the root <Toaster/> has subscribed (see
    // use-google-status-toast.ts for why).
    if (msg) setTimeout(() => (msg.ok ? toast.success(msg.text) : toast.error(msg.text)), 0);
    params.delete("gcal");
    const qs = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
  }, []);
}

export function GoogleCalendarCard() {
  const { subAccountId, subAccount } = useSubAccount();
  // Re-fetch when the gate flips; the route answers either way.
  const gateOn = subAccount?.googleCalendarEnabledByAgency === true;
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useGcalStatusToast();

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/google-calendar`);
      const data = (await res.json().catch(() => ({}))) as Partial<Status> & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn't load your Google Calendar status.");
      setStatus(data as Status);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
    }
  }, [subAccountId]);

  useEffect(() => {
    void load();
  }, [gateOn, load]);

  if (status?.gateOff && !status.connected) return null;
  if (!status && !gateOn) return null;

  function connect() {
    // Full-page nav so the OAuth redirect chain works.
    window.location.href = `/api/sub-accounts/${subAccountId}/google-calendar/connect`;
  }

  async function disconnect() {
    if (!confirm("Disconnect your Google Calendar? We stop syncing and delete our stored access; events already added stay in your calendar.")) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/google-calendar`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to disconnect.");
      toast.success("Google Calendar disconnected.");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to disconnect.");
    } finally {
      setBusy(false);
    }
  }

  const disconnectButton = (
    <Button type="button" variant="outline" size="sm" disabled={busy} onClick={disconnect} data-testid="gcal-disconnect">
      {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
      Disconnect
    </Button>
  );

  return (
    <div className="mb-5 rounded-lg border bg-background p-4" data-testid="gcal-card">
      <p className="text-sm font-medium">Google Calendar</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Bookings assigned to you are added to your Google Calendar, and your
        Google busy time blocks those slots on booking pages. Only your
        primary calendar is used. Disconnecting stops the sync; to also remove
        the app&apos;s access from your Google account, visit{" "}
        <a
          href="https://myaccount.google.com/permissions"
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline-offset-2 hover:underline"
        >
          myaccount.google.com/permissions
        </a>
        .
      </p>

      <div className="mt-3">
        {status?.gateOff ? (
          <div className="flex flex-wrap items-center justify-between gap-3" data-testid="gcal-gate-off">
            <p className="text-xs text-muted-foreground">
              Google Calendar sync is switched off by your agency. Your connection
              {status.googleEmail ? ` (${status.googleEmail})` : ""} is still stored.
            </p>
            {disconnectButton}
          </div>
        ) : error ? (
          <p className="text-sm text-rose-700 dark:text-rose-400">{error}</p>
        ) : !status ? (
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        ) : status.status === "revoked" ? (
          <div className="flex flex-wrap items-center justify-between gap-3" data-testid="gcal-revoked">
            <div className="space-y-1">
              <p className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-4 w-4" />
                Google no longer accepts this connection
              </p>
              {status.lastError && <p className="text-xs text-muted-foreground">{status.lastError}</p>}
            </div>
            <div className="flex items-center gap-1.5">
              <Button type="button" size="sm" onClick={connect} data-testid="gcal-reconnect">
                Reconnect
              </Button>
              {disconnectButton}
            </div>
          </div>
        ) : status.connected ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <p className="flex items-center gap-2 text-sm font-medium" data-testid="gcal-connected">
                <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                Connected as {status.googleEmail ?? "your Google account"} (primary calendar)
              </p>
              {status.lastError && (
                <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="gcal-last-error">
                  Busy time: {status.lastError}
                </p>
              )}
              {status.lastPushError && (
                <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="gcal-last-push-error">
                  Last booking not added: {status.lastPushError} Open the booking and use Retry sync.
                </p>
              )}
            </div>
            {disconnectButton}
          </div>
        ) : !status.configured ? (
          <p className="text-sm text-muted-foreground">Google isn&apos;t configured on this deployment yet.</p>
        ) : (
          <Button type="button" size="sm" onClick={connect} data-testid="gcal-connect">
            Connect Google Calendar
          </Button>
        )}
      </div>
    </div>
  );
}
