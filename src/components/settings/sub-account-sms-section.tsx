"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  HelpCircle,
  Loader2,
  Lock,
  MessageCircle,
  MessageSquare,
  PhoneMissed,
} from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Sub-account SMS settings panel.
 *
 * Collapsed-by-default disclosure: an "Enable a dedicated Twilio number"
 * toggle. When ON, reveals a credentials form (Account SID / Auth Token /
 * From Number) + a Save+Test button. On save we POST /api/sub-accounts/[id]/twilio
 * which validates creds with Twilio + best-effort sets the inbound webhook
 * URL on the operator's number.
 *
 * If auto-config of the inbound webhook fails, we surface a copy-button row
 * with the manual URL so the operator can paste it into their Twilio console.
 *
 * Disable flow: DELETE /api/sub-accounts/[id]/twilio sets enabled=false but
 * keeps the creds. Toggling back on is one click.
 */

export function SubAccountSmsSection() {
  const { subAccountId, subAccount, isAdmin, loading } = useSubAccount();
  // Disabling dedicated SMS moves this workspace onto the AGENCY's shared
  // number (spends the agency's balance, loses inbound routing) — the
  // DELETE route is agency-owner-only, so only show owners the control.
  const { agencyRole } = useAuth();
  const isAgencyOwner = agencyRole === "owner";
  const cfg = subAccount?.twilioConfig ?? null;

  const [enabled, setEnabled] = useState<boolean>(!!cfg?.enabled);
  const [accountSid, setAccountSid] = useState(cfg?.accountSid ?? "");
  const [authToken, setAuthToken] = useState(""); // never reveal — write-only
  const [fromNumber, setFromNumber] = useState(cfg?.fromNumber ?? "");
  const [saving, setSaving] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [lastResult, setLastResult] = useState<{
    inboundWebhookConfigured: boolean;
    inboundWebhookError: string | null;
    friendlyName: string | null;
  } | null>(null);

  // WhatsApp sender (reuses the Twilio creds above; only the sending number
  // + sandbox flag differ). Managed via /api/sub-accounts/[id]/twilio/whatsapp.
  const [waNumber, setWaNumber] = useState(cfg?.whatsappFromNumber ?? "");
  const [waSandbox, setWaSandbox] = useState(!!cfg?.whatsappSandbox);
  const [waSaving, setWaSaving] = useState(false);
  const [waRemoving, setWaRemoving] = useState(false);
  const [waResult, setWaResult] = useState<{
    inboundWebhookConfigured: boolean;
    inboundWebhookError: string | null;
  } | null>(null);

  // Missed Call Text Back (MCTB). Agency-gated; requires dedicated Twilio.
  const mctbGateOn = subAccount?.missedCallTextBackEnabledByAgency === true;
  const mctb = cfg?.missedCall ?? null;
  const DEFAULT_MCTB_MESSAGE =
    "Sorry we missed your call! Reply to this text and we'll help you right away.";
  const [mcEnabled, setMcEnabled] = useState<boolean>(!!mctb?.enabled);
  const [mcForwardTo, setMcForwardTo] = useState(mctb?.forwardTo ?? "");
  const [mcRing, setMcRing] = useState<number>(mctb?.ringTimeoutSec ?? 20);
  const [mcMessage, setMcMessage] = useState(mctb?.messageBody ?? "");
  const [mcSaving, setMcSaving] = useState(false);
  const [mcDisabling, setMcDisabling] = useState(false);
  const [mcResult, setMcResult] = useState<{
    voiceWebhookConfigured: boolean;
    voiceWebhookError: string | null;
  } | null>(null);

  // Re-sync local state when the snapshot lands or the user navigates between
  // sub-accounts.
  useEffect(() => {
    setEnabled(!!cfg?.enabled);
    setAccountSid(cfg?.accountSid ?? "");
    setFromNumber(cfg?.fromNumber ?? "");
    setAuthToken("");
    setWaNumber(cfg?.whatsappFromNumber ?? "");
    setWaSandbox(!!cfg?.whatsappSandbox);
    setMcEnabled(!!cfg?.missedCall?.enabled);
    setMcForwardTo(cfg?.missedCall?.forwardTo ?? "");
    setMcRing(cfg?.missedCall?.ringTimeoutSec ?? 20);
    setMcMessage(cfg?.missedCall?.messageBody ?? "");
  }, [
    cfg?.enabled,
    cfg?.accountSid,
    cfg?.fromNumber,
    cfg?.whatsappFromNumber,
    cfg?.whatsappSandbox,
    cfg?.missedCall?.enabled,
    cfg?.missedCall?.forwardTo,
    cfg?.missedCall?.ringTimeoutSec,
    cfg?.missedCall?.messageBody,
    subAccountId,
  ]);

  const webhookUrl = useMemo(() => {
    const base =
      typeof window !== "undefined"
        ? window.location.origin
        : (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
    return `${base}/api/webhooks/twilio/inbound`;
  }, []);

  const whatsappWebhookUrl = useMemo(() => {
    const base =
      typeof window !== "undefined"
        ? window.location.origin
        : (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
    return `${base}/api/webhooks/twilio/whatsapp/inbound`;
  }, []);

  const voiceWebhookUrl = useMemo(() => {
    const base =
      typeof window !== "undefined"
        ? window.location.origin
        : (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
    return `${base}/api/webhooks/twilio/voice`;
  }, []);

  if (!isAdmin) return null;

  const isExistingConfig = !!cfg && !!cfg.accountSid;

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/twilio`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountSid: accountSid.trim(),
          authToken: authToken.trim(),
          fromNumber: fromNumber.trim(),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        friendlyName?: string | null;
        inboundWebhookConfigured?: boolean;
        inboundWebhookError?: string | null;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Failed to save Twilio config.");
      }
      setLastResult({
        friendlyName: data.friendlyName ?? null,
        inboundWebhookConfigured: !!data.inboundWebhookConfigured,
        inboundWebhookError: data.inboundWebhookError ?? null,
      });
      setAuthToken("");
      toast.success("Twilio connected. Dedicated SMS is live.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDisable() {
    if (
      !confirm(
        "Disable dedicated SMS for this sub-account? Outbound sends will revert to the shared sender. Inbound replies stop being captured. Your Twilio creds stay saved so you can re-enable in one click."
      )
    ) {
      return;
    }
    setDisabling(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/twilio`, {
        method: "DELETE",
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Failed to disable.");
      }
      setEnabled(false);
      toast.success("Dedicated SMS disabled. Reverted to shared sender.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to disable.");
    } finally {
      setDisabling(false);
    }
  }

  function copyWebhook() {
    void navigator.clipboard.writeText(webhookUrl);
    toast.success("Webhook URL copied. Paste into Twilio's number config.");
  }

  async function handleSaveWhatsapp() {
    setWaSaving(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/twilio/whatsapp`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            whatsappFromNumber: waNumber.trim(),
            sandbox: waSandbox,
          }),
        }
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        inboundWebhookConfigured?: boolean;
        inboundWebhookError?: string | null;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Failed to save WhatsApp sender.");
      }
      setWaResult({
        inboundWebhookConfigured: !!data.inboundWebhookConfigured,
        inboundWebhookError: data.inboundWebhookError ?? null,
      });
      toast.success("WhatsApp sender saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setWaSaving(false);
    }
  }

  async function handleRemoveWhatsapp() {
    if (
      !confirm(
        "Remove the WhatsApp sender for this sub-account? The WhatsApp AI channel will go silent. Your Twilio creds and SMS config stay intact."
      )
    ) {
      return;
    }
    setWaRemoving(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/twilio/whatsapp`,
        { method: "DELETE" }
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Failed to remove.");
      }
      setWaNumber("");
      setWaSandbox(false);
      setWaResult(null);
      toast.success("WhatsApp sender removed.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove.");
    } finally {
      setWaRemoving(false);
    }
  }

  function copyWhatsappWebhook() {
    void navigator.clipboard.writeText(whatsappWebhookUrl);
    toast.success("WhatsApp webhook URL copied.");
  }

  function copyVoiceWebhook() {
    void navigator.clipboard.writeText(voiceWebhookUrl);
    toast.success("Voice webhook URL copied.");
  }

  async function handleSaveMctb() {
    setMcSaving(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/missed-call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          forwardTo: mcForwardTo.trim(),
          ringTimeoutSec: mcRing,
          messageBody: mcMessage.trim(),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        voiceWebhookConfigured?: boolean;
        voiceWebhookError?: string | null;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Failed to save Missed Call Text Back.");
      }
      setMcResult({
        voiceWebhookConfigured: !!data.voiceWebhookConfigured,
        voiceWebhookError: data.voiceWebhookError ?? null,
      });
      toast.success("Missed Call Text Back is live.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setMcSaving(false);
    }
  }

  async function handleDisableMctb() {
    if (
      !confirm(
        "Disable Missed Call Text Back? The number's voice line reverts to its previous setting and callers are no longer auto-texted. Your forward number + message stay saved for one-click re-enable."
      )
    ) {
      return;
    }
    setMcDisabling(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/missed-call`, {
        method: "DELETE",
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Failed to disable.");
      }
      setMcEnabled(false);
      setMcResult(null);
      toast.success("Missed Call Text Back disabled.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to disable.");
    } finally {
      setMcDisabling(false);
    }
  }

  return (
    <section className="bg-card rounded-2xl border p-6">
      <header className="mb-4 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
          <MessageSquare className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">SMS</h2>
          <p className="text-muted-foreground mt-0.5 text-sm">
            Use a dedicated Twilio number for this sub-account so customer
            replies land in a chat thread on each contact profile. Without one,
            sends use the shared deployment-wide sender —{" "}
            <strong>customer replies can&apos;t be routed back</strong> to this
            workspace and are lost. Turning dedicated SMS off again is an
            agency-owner action.
          </p>
        </div>
      </header>

      <label className="bg-background flex items-start gap-3 rounded-lg border p-3">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          disabled={saving || disabling}
          className="mt-0.5 h-4 w-4 cursor-pointer"
        />
        <div>
          <p className="text-sm font-medium">
            Use a dedicated Twilio number for this sub-account
          </p>
          <p className="text-muted-foreground text-xs">
            When on, outbound sends use the credentials below and inbound
            replies are routed to a chat thread on each contact.
          </p>
        </div>
      </label>

      {enabled && (
        <form onSubmit={handleSave} className="mt-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="twilio-sid">Account SID</Label>
              <Input
                id="twilio-sid"
                value={accountSid}
                onChange={(e) => setAccountSid(e.target.value)}
                placeholder="AC…"
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-muted-foreground text-[11px]">
                Twilio Console → Account Info.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="twilio-token">Auth Token</Label>
              <Input
                id="twilio-token"
                type="password"
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
                placeholder={
                  isExistingConfig ? "•••••••••••••• (leave blank to keep)" : ""
                }
                autoComplete="new-password"
                spellCheck={false}
              />
              <p className="text-muted-foreground text-[11px]">
                Stored in Firestore, never displayed back.
                {isExistingConfig
                  ? " Leave blank to keep the token you saved before."
                  : ""}
              </p>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="twilio-from">From Number</Label>
              <Input
                id="twilio-from"
                value={fromNumber}
                onChange={(e) => setFromNumber(e.target.value)}
                placeholder="+15551234567"
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-muted-foreground text-[11px]">
                E.164 format. Must be a number this Twilio account owns.
              </p>
            </div>
          </div>

          <div className="bg-muted/30 text-muted-foreground rounded-lg border p-3 text-xs">
            <p className="text-foreground font-medium">Inbound webhook URL</p>
            <p className="mt-1">
              On save, we automatically point this number&apos;s inbound webhook
              here. If that fails (Twilio account permissions, etc.) paste this
              URL into the number&apos;s &ldquo;A MESSAGE COMES IN&rdquo;
              setting in the Twilio console:
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="bg-background flex-1 truncate rounded px-2 py-1.5 text-[11px]">
                {webhookUrl}
              </code>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={copyWebhook}
              >
                <Copy className="mr-1 h-3 w-3" />
                Copy
              </Button>
            </div>
          </div>

          {lastResult && (
            <div
              className={
                lastResult.inboundWebhookConfigured
                  ? "rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm"
                  : "rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm"
              }
            >
              {lastResult.inboundWebhookConfigured ? (
                <p className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
                  <CheckCircle2 className="h-4 w-4" />
                  Connected
                  {lastResult.friendlyName
                    ? ` — ${lastResult.friendlyName}`
                    : ""}
                  . Inbound webhook configured automatically.
                </p>
              ) : (
                <p className="flex items-start gap-2 text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    Saved, but couldn&apos;t auto-configure the inbound webhook:{" "}
                    {lastResult.inboundWebhookError ?? "unknown error"}.
                    Configure it manually using the URL above.
                  </span>
                </p>
              )}
            </div>
          )}

          <div className="flex items-center justify-between gap-3">
            <p className="text-muted-foreground text-[11px]">
              Saving validates the credentials with Twilio before they go live.
            </p>
            <div className="flex gap-2">
              {isExistingConfig && cfg?.enabled && isAgencyOwner && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={disabling || saving}
                  onClick={handleDisable}
                >
                  {disabling ? (
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  Disable
                </Button>
              )}
              <Button type="submit" size="sm" disabled={saving}>
                {saving ? (
                  <>
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    Saving…
                  </>
                ) : (
                  "Save & test"
                )}
              </Button>
            </div>
          </div>
        </form>
      )}

      {isExistingConfig && cfg?.enabled && (
        <div className="bg-background mt-6 rounded-lg border p-4">
          <div className="flex items-start gap-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-green-500/10 text-green-600 dark:text-green-400">
              <MessageCircle className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-semibold">WhatsApp sender</h3>
              <p className="text-muted-foreground mt-0.5 text-xs">
                Reuses the Twilio credentials above. Add the WhatsApp sender
                number registered to your Twilio WhatsApp Business sender, then
                enable the WhatsApp AI channel under AI Agents → WhatsApp.
                Testing before your sender is approved? Use the sandbox.
              </p>
            </div>
          </div>

          <label className="mt-3 flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={waSandbox}
              onChange={(e) => setWaSandbox(e.target.checked)}
              disabled={waSaving || waRemoving}
              className="h-3.5 w-3.5 cursor-pointer"
            />
            <span>
              Use the Twilio WhatsApp Sandbox (shared number{" "}
              <code className="text-[11px]">+14155238886</code> — for testing)
            </span>
          </label>

          {!waSandbox && (
            <div className="mt-3 space-y-1.5">
              <Label htmlFor="wa-from">WhatsApp sender number</Label>
              <Input
                id="wa-from"
                value={waNumber}
                onChange={(e) => setWaNumber(e.target.value)}
                placeholder="+15551234567"
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-muted-foreground text-[11px]">
                E.164. The number registered to your Twilio WhatsApp sender /
                WABA.
              </p>
            </div>
          )}

          <div className="bg-muted/30 text-muted-foreground mt-3 rounded-lg border p-3 text-xs">
            <p className="text-foreground font-medium">Inbound webhook URL</p>
            <p className="mt-1">
              On save we point the sender&apos;s inbound webhook here. In
              sandbox mode, set this manually under Twilio → Messaging → Try it
              out → WhatsApp sandbox settings:
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="bg-background flex-1 truncate rounded px-2 py-1.5 text-[11px]">
                {whatsappWebhookUrl}
              </code>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={copyWhatsappWebhook}
              >
                <Copy className="mr-1 h-3 w-3" />
                Copy
              </Button>
            </div>
          </div>

          {waResult && (
            <div
              className={
                waResult.inboundWebhookConfigured
                  ? "mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm"
                  : "mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm"
              }
            >
              {waResult.inboundWebhookConfigured ? (
                <p className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
                  <CheckCircle2 className="h-4 w-4" />
                  Saved. Inbound webhook configured automatically.
                </p>
              ) : (
                <p className="flex items-start gap-2 text-amber-700 dark:text-amber-400">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    Saved, but the inbound webhook needs manual config:{" "}
                    {waResult.inboundWebhookError ?? "unknown error"}. Use the
                    URL above.
                  </span>
                </p>
              )}
            </div>
          )}

          <div className="mt-3 flex justify-end gap-2">
            {cfg?.whatsappFromNumber && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={waSaving || waRemoving}
                onClick={handleRemoveWhatsapp}
              >
                {waRemoving ? (
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                ) : null}
                Remove
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              disabled={waSaving || (!waSandbox && !waNumber.trim())}
              onClick={handleSaveWhatsapp}
            >
              {waSaving ? (
                <>
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  Saving…
                </>
              ) : (
                "Save WhatsApp sender"
              )}
            </Button>
          </div>
        </div>
      )}

      <div className="bg-background mt-6 rounded-lg border p-4">
        <div className="flex items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-rose-500/10 text-rose-600 dark:text-rose-400">
            <PhoneMissed className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold">Missed Call Text Back</h3>
            <p className="text-muted-foreground mt-0.5 text-xs">
              Inbound calls to this number ring your real phone first. If no one
              picks up, the caller is automatically texted back so the lead
              isn&apos;t lost. Uses this sub-account&apos;s Twilio number.
            </p>
          </div>
        </div>

        {/* Until the workspace doc arrives the gate reads as off; showing
            "Locked" then flashes it on every load of a workspace that has it on. */}
        {loading ? null : !mctbGateOn ? (
          <div className="bg-muted/30 text-muted-foreground mt-3 flex items-start gap-2 rounded-lg border p-3 text-xs">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              <strong className="text-foreground">
                Locked by your agency.
              </strong>{" "}
              This feature isn&apos;t switched on for your sub-account yet — ask
              your agency owner to enable &ldquo;Missed Call Text Back&rdquo;.
              The guide below explains what it does and what you&apos;ll need.
            </span>
          </div>
        ) : !(isExistingConfig && cfg?.enabled) ? (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Almost there — enable a <strong>dedicated Twilio number</strong>{" "}
              for this sub-account above first, then come back here to switch
              Missed Call Text Back on.
            </span>
          </div>
        ) : (
          <>
            <label className="bg-card mt-3 flex items-start gap-3 rounded-lg border p-3">
              <input
                type="checkbox"
                checked={mcEnabled}
                onChange={(e) => setMcEnabled(e.target.checked)}
                disabled={mcSaving || mcDisabling}
                className="mt-0.5 h-4 w-4 cursor-pointer"
              />
              <div>
                <p className="text-sm font-medium">
                  Forward calls, text back on a miss
                </p>
                <p className="text-muted-foreground text-xs">
                  Can&apos;t be used together with the AI inbound Voice agent
                  (it answers calls itself). Turn off AI Voice first if
                  it&apos;s on.
                </p>
              </div>
            </label>

            {mcEnabled && (
              <div className="mt-4 space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="mctb-forward">Forward to number</Label>
                    <Input
                      id="mctb-forward"
                      value={mcForwardTo}
                      onChange={(e) => setMcForwardTo(e.target.value)}
                      placeholder="+15551234567"
                      autoComplete="off"
                      spellCheck={false}
                    />
                    <p className="text-muted-foreground text-[11px]">
                      E.164. The business&apos;s real phone the call rings
                      first.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="mctb-ring">Ring timeout (seconds)</Label>
                    <Input
                      id="mctb-ring"
                      type="number"
                      min={5}
                      max={60}
                      value={mcRing}
                      onChange={(e) => setMcRing(Number(e.target.value) || 20)}
                    />
                    <p className="text-muted-foreground text-[11px]">
                      How long to ring before it counts as missed (5–60).
                    </p>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="mctb-message">Text-back message</Label>
                  <textarea
                    id="mctb-message"
                    value={mcMessage}
                    onChange={(e) => setMcMessage(e.target.value)}
                    rows={3}
                    placeholder={DEFAULT_MCTB_MESSAGE}
                    className="border-input bg-background focus:ring-ring w-full rounded-md border px-3 py-2 text-sm focus:ring-2 focus:outline-none"
                  />
                  <p className="text-muted-foreground text-[11px]">
                    Sent to the caller on a miss. Optional tags:{" "}
                    <code className="text-[10px]">{"{{firstName}}"}</code>,{" "}
                    <code className="text-[10px]">{"{{businessName}}"}</code>.
                    Leave blank for the default.
                  </p>
                </div>

                <div className="bg-muted/30 text-muted-foreground rounded-lg border p-3 text-xs">
                  <p className="text-foreground font-medium">
                    Voice webhook URL
                  </p>
                  <p className="mt-1">
                    On <strong>Save &amp; activate</strong> we point this
                    number&apos;s &ldquo;A CALL COMES IN&rdquo; webhook here
                    automatically. If that fails (Twilio account permissions),
                    paste this into the number&apos;s <strong>Voice</strong>{" "}
                    configuration in the Twilio console:
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <code className="bg-background flex-1 truncate rounded px-2 py-1.5 text-[11px]">
                      {voiceWebhookUrl}
                    </code>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={copyVoiceWebhook}
                    >
                      <Copy className="mr-1 h-3 w-3" />
                      Copy
                    </Button>
                  </div>
                </div>

                {mcResult && (
                  <div
                    className={
                      mcResult.voiceWebhookConfigured
                        ? "rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm"
                        : "rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm"
                    }
                  >
                    {mcResult.voiceWebhookConfigured ? (
                      <p className="flex items-center gap-2 text-emerald-700 dark:text-emerald-400">
                        <CheckCircle2 className="h-4 w-4" />
                        Live. The number&apos;s voice line now forwards and
                        texts back on a miss.
                      </p>
                    ) : (
                      <p className="flex items-start gap-2 text-amber-700 dark:text-amber-400">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>
                          Saved, but couldn&apos;t auto-configure the
                          number&apos;s voice webhook:{" "}
                          {mcResult.voiceWebhookError ?? "unknown error"}. Set
                          the number&apos;s &ldquo;A CALL COMES IN&rdquo; URL to{" "}
                          <code className="text-[11px]">
                            /api/webhooks/twilio/voice
                          </code>{" "}
                          manually.
                        </span>
                      </p>
                    )}
                  </div>
                )}

                <div className="flex items-center justify-end gap-2">
                  {mctb?.enabled && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={mcDisabling || mcSaving}
                      onClick={handleDisableMctb}
                    >
                      {mcDisabling ? (
                        <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                      ) : null}
                      Disable
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    disabled={mcSaving || !mcForwardTo.trim()}
                    onClick={handleSaveMctb}
                  >
                    {mcSaving ? (
                      <>
                        <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                        Saving…
                      </>
                    ) : (
                      "Save & activate"
                    )}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}

        {/* Reference guide — how it works + troubleshooting. Placed BELOW the
            controls (consistent with the Facebook/Instagram card) and always
            visible, so an owner can read it even when the feature is locked. */}
        <div className="bg-muted/30 text-muted-foreground mt-3 rounded-lg border p-3 text-xs">
          <p className="text-foreground font-medium">How it works</p>
          <ol className="mt-1 list-decimal space-y-1 pl-4">
            <li>
              A customer calls this sub-account&apos;s dedicated Twilio number.
            </li>
            <li>
              The call is{" "}
              <strong>forwarded to your &ldquo;Forward to&rdquo; number</strong>{" "}
              and rings for the timeout you set.
            </li>
            <li>
              If someone answers, it&apos;s a normal call — no text is sent.
            </li>
            <li>
              If it goes <strong>unanswered</strong> (no answer, busy, or the
              line fails), the caller is automatically sent your text-back.
            </li>
            <li>
              The caller is saved as a contact (matched by phone), the missed
              call + text are logged on their timeline, and the thread appears
              in <strong>Conversations</strong> so you can keep replying.
            </li>
          </ol>

          <p className="text-foreground mt-3 font-medium">
            Before you can use it
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            <li>
              <strong>Your agency switches this feature on</strong> for your
              sub-account. If it&apos;s locked, ask your agency owner to enable
              &ldquo;Missed Call Text Back&rdquo; for you.
            </li>
            <li>
              A <strong>dedicated Twilio number enabled above</strong> (Settings
              → SMS). It uses this sub-account&apos;s own number — never a
              shared one.
            </li>
            <li>
              That number must be <strong>voice- and SMS-capable</strong> (most
              local Twilio numbers are; some toll-free / voice-disabled numbers
              aren&apos;t).
            </li>
            <li>
              The <strong>AI inbound Voice agent must be OFF</strong> for this
              number — a number can only route calls to one place.
            </li>
            <li>
              A <strong>&ldquo;Forward to&rdquo; number</strong> — the real
              phone (mobile / desk) that should ring first.
            </li>
          </ul>

          <details className="bg-background/60 mt-3 rounded-md border p-3">
            <summary className="text-foreground flex cursor-pointer items-center gap-1.5 text-[11px] font-medium">
              <HelpCircle className="h-3.5 w-3.5" />
              Notes &amp; troubleshooting
            </summary>
            <div className="mt-3 space-y-3 text-[11px] leading-relaxed">
              <div>
                <p className="text-foreground font-medium">
                  What counts as &ldquo;missed&rdquo;
                </p>
                <p className="mt-1">
                  The forward returning <strong>no answer</strong>,{" "}
                  <strong>busy</strong>, or <strong>failed</strong>. A call
                  someone actually answers never triggers a text.
                </p>
              </div>
              <div>
                <p className="text-foreground font-medium">
                  Compliance &amp; safety
                </p>
                <ul className="mt-1 list-disc space-y-1 pl-4">
                  <li>
                    A caller who replied <strong>STOP</strong> (opted out of
                    SMS) is <strong>not</strong> texted — the missed call is
                    still logged.
                  </li>
                  <li>
                    <strong>One text per call</strong> — Twilio retries
                    won&apos;t double-text the caller.
                  </li>
                  <li>
                    The business&apos;s phone sees the{" "}
                    <strong>caller&apos;s real number</strong> when the call
                    forwards.
                  </li>
                </ul>
              </div>
              <div>
                <p className="text-foreground font-medium">
                  Turning it off / conflicts with AI Voice
                </p>
                <p className="mt-1">
                  <strong>Disable</strong> restores the number&apos;s previous
                  voice setting. If you later enable{" "}
                  <strong>AI inbound Voice</strong> on this number, it takes
                  over the call line and MCTB stops receiving calls — use one or
                  the other per number, not both.
                </p>
              </div>
              <p className="text-muted-foreground">
                Message tags you can use:{" "}
                <code className="bg-muted rounded px-1">{"{{firstName}}"}</code>{" "}
                (often blank for a brand-new caller) and{" "}
                <code className="bg-muted rounded px-1">
                  {"{{businessName}}"}
                </code>
                .
              </p>
            </div>
          </details>
        </div>
      </div>
    </section>
  );
}
