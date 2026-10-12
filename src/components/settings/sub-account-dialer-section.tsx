"use client";

import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Lock, Phone } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { dialerTwilioConfigured } from "@/lib/comms/dialer-shared";

/**
 * Softphone v1 — the "Phone dialer" settings card (Messaging tab, admin-only).
 *
 * Enable provisions a Twilio API Key + TwiML App on the sub-account's OWN
 * Twilio account (Settings → SMS creds) via POST /api/sub-accounts/[id]/dialer;
 * after that the Call button appears on contact profiles and members dial from
 * the browser with the sub-account's number as caller ID. Recording is a
 * separate opt-in (consent laws vary by region — default off).
 *
 * Ours differs from upstream: the card is locked while the agency gate
 * `dialerEnabledByAgency` is off (upstream has no gate), and "Twilio ready"
 * means dedicated Twilio is on AND complete, as the server reads it. Disable
 * is offered whenever a dialer is provisioned, locked or not — the server
 * keeps DELETE ungated so a sub-account can always remove what it set up.
 * NOT runtime-verified against a real Twilio account (docs/features/dialer.md).
 */
export function SubAccountDialerSection() {
  const { subAccountId, subAccount, isAdmin, loading } = useSubAccount();
  const [busy, setBusy] = useState(false);

  if (!isAdmin) return null;

  const gateOn = subAccount?.dialerEnabledByAgency === true;
  const twilioReady = dialerTwilioConfigured(subAccount?.twilioConfig);
  const cfg = subAccount?.dialerConfig ?? null;
  const enabled = cfg?.enabled === true;
  const recording = cfg?.recordCalls === true;

  async function callApi(
    method: "POST" | "PATCH" | "DELETE",
    body?: Record<string, unknown>,
    okMessage?: string,
  ) {
    setBusy(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/dialer`, {
        method,
        ...(body
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }
          : {}),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Request failed.");
      }
      if (okMessage) toast.success(okMessage);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  }

  function disable() {
    if (
      confirm(
        twilioReady
          ? "Disable the dialer? The calling app + API key are removed from your Twilio account and the Call button disappears."
          : "Disable the dialer? The Call button disappears. Your dedicated Twilio number is switched off, so the calling app + API key can't be removed automatically — delete them in your Twilio console.",
      )
    ) {
      void callApi("DELETE", undefined, "Dialer disabled.");
    }
  }

  const disableButton = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={disable}
    >
      Disable
    </Button>
  );

  return (
    <section
      className="rounded-2xl border bg-card p-6"
      data-testid="dialer-section"
    >
      <header className="mb-4 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-teal-500/10 text-teal-600 dark:text-teal-400">
          <Phone className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold">Phone dialer</h2>
            <span className="rounded-full bg-fuchsia-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-fuchsia-600 dark:text-fuchsia-400">
              Beta
            </span>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Call contacts from the browser through your own Twilio account —
            your dedicated number shows as caller ID, and each call logs to the
            contact&apos;s activity timeline. Outbound only: your number&apos;s
            inbound setup (AI Voice / missed-call text-back) is untouched.
          </p>
        </div>
      </header>

      {/* Until the workspace doc arrives the gate reads as off; showing
          "Locked" then flashes it on every load of a workspace that has it on. */}
      {loading ? (
        <Loader2 className="mx-auto h-4 w-4 animate-spin text-muted-foreground" />
      ) : !gateOn ? (
        <div className="space-y-4">
          <div className="flex items-start gap-3 rounded-lg border border-dashed bg-muted/30 p-4 text-sm">
            <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="text-muted-foreground">
              <p className="font-medium text-foreground">
                Locked by your agency.
              </p>
              <p className="mt-1">
                This feature isn&apos;t switched on for your sub-account yet —
                ask your agency owner to enable &ldquo;Phone dialer&rdquo;.
              </p>
            </div>
          </div>
          {enabled && (
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                A dialer was set up here before it was locked. It places no
                calls while locked; you can still remove it.
              </p>
              {disableButton}
            </div>
          )}
        </div>
      ) : !twilioReady ? (
        <div className="space-y-4">
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Almost there — enable a <strong>dedicated Twilio number</strong>{" "}
              for this sub-account above first, then come back here to switch
              the phone dialer on. The dialer places calls through that
              account; calls bill to your Twilio at their standard per-minute
              rate.
            </span>
          </div>
          {enabled && (
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                The dialer places no calls while your dedicated Twilio number
                is off.
              </p>
              {disableButton}
            </div>
          )}
        </div>
      ) : !enabled ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            Enabling creates a calling app + API key on your Twilio account.
            No extra services, no monthly fee — per-minute Twilio rates only.
          </p>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => void callApi("POST", undefined, "Dialer enabled. The Call button now shows on contact profiles.")}
          >
            {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
            Enable dialer
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={recording}
              disabled={busy}
              onChange={(e) =>
                void callApi(
                  "PATCH",
                  { recordCalls: e.target.checked },
                  e.target.checked
                    ? "Call recording on."
                    : "Call recording off.",
                )
              }
            />
            <span>
              <span className="font-medium">Record calls</span>
              <span className="block text-xs text-muted-foreground">
                Dual-channel, from answer. Off by default — recording-consent
                laws vary by region; confirm your obligations before turning
                this on. Recording links appear on the call&apos;s activity
                entry. Anyone holding a link can open it unless you switch on
                &ldquo;Enforce HTTP Auth on Media URLs&rdquo; in your Twilio
                console.
              </span>
            </span>
          </label>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Members place calls from the Call button on any contact whose
              phone number is saved in international format (+27…). Contacts
              marked &quot;opted out of calls&quot; are blocked.
            </p>
            {disableButton}
          </div>
        </div>
      )}
    </section>
  );
}
