"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  MonitorPlay,
} from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Webinar1 connection card — link this sub-account to a self-hosted Webinar1
 * deployment (base URL + `wbk_…` API key from its Settings → API tab).
 *
 * The key is never rendered back: the server stores it in the locked
 * `private/` subcollection and this card reads only `webinar1ConnectionMeta`
 * (base URL, key prefix, webhook state) off the sub-account doc. Same
 * secret-handling model as the Stripe card above it.
 *
 * Admin-only (self-gates). The connect flow also registers our inbound
 * webhook on the webinar deployment; when that fails (e.g. local dev with no
 * public URL) the card shows the manual signing-secret fallback.
 */
export function SubAccountWebinar1Section() {
  const { subAccountId, subAccount, isAdmin, saPath } = useSubAccount();
  const meta = subAccount?.webinar1ConnectionMeta ?? null;
  const connected = !!meta;

  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [manualSecret, setManualSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  // Only populated when auto-registration failed — drives the manual panel.
  const [pendingWebhook, setPendingWebhook] = useState<{
    url: string | null;
    error: string | null;
  } | null>(null);

  if (!isAdmin) return null;
  // Agency gate — self-gating like the Stripe card above: render nothing
  // until the agency owner enables Webinars for this sub-account.
  if (subAccount?.webinar1EnabledByAgency !== true) return null;

  async function handleConnect(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/webinar1-connection`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            baseUrl: baseUrl.trim(),
            apiKey: apiKey.trim(),
          }),
        }
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        webhookReady?: boolean;
        webhookUrl?: string | null;
        webhookError?: string | null;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Couldn't connect the webinar platform.");
      }
      setBaseUrl("");
      setApiKey("");
      if (data.webhookReady) {
        setPendingWebhook(null);
        toast.success("Webinar platform connected.");
      } else {
        setPendingWebhook({
          url: data.webhookUrl ?? null,
          error: data.webhookError ?? null,
        });
        toast.warning(
          "Connected — one more step to receive registrations back."
        );
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't connect the platform."
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveSecret(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/webinar1-connection`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ webhookSecret: manualSecret.trim() }),
        }
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Couldn't save the signing secret.");
      }
      setManualSecret("");
      setPendingWebhook(null);
      toast.success("Webhook connected — registrations will sync in.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDisconnect() {
    if (
      !confirm(
        "Disconnect the webinar platform? Webinars keep running on it, but registrations stop syncing into the CRM and you can't create webinars from here until you reconnect."
      )
    ) {
      return;
    }
    setDisconnecting(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/webinar1-connection`,
        { method: "DELETE" }
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Failed to disconnect.");
      }
      setPendingWebhook(null);
      toast.success("Webinar platform disconnected.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to disconnect.");
    } finally {
      setDisconnecting(false);
    }
  }

  const needsWebhook = connected && meta && !meta.webhookReady;

  return (
    <section className="bg-card rounded-2xl border p-6">
      <header className="mb-4 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
          <MonitorPlay className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">Webinars — Webinar1</h2>
          <p className="text-muted-foreground mt-0.5 text-sm">
            Connect a Webinar1 deployment to create evergreen webinars from the
            CRM, push contacts into them, and pull registrations + attendance
            back onto contact timelines.
          </p>
        </div>
      </header>

      {connected ? (
        <div className="space-y-3">
          <div
            className={
              needsWebhook
                ? "rounded-lg border border-amber-500/30 bg-amber-500/5 p-4"
                : "rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4"
            }
          >
            {needsWebhook ? (
              <p className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-4 w-4" />
                Connected — but registrations can&apos;t sync back yet
              </p>
            ) : (
              <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="h-4 w-4" />
                Connected to{" "}
                <span className="font-semibold">{meta!.baseUrl}</span>
              </p>
            )}
            <p className="text-muted-foreground mt-2 text-xs">
              API key {meta!.keyPrefix}… · manage webinars on the{" "}
              <Link
                href={saPath("/webinars")}
                className="text-primary underline"
              >
                Webinars page
              </Link>
            </p>
            <div className="mt-3 flex justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleDisconnect}
                disabled={disconnecting}
              >
                {disconnecting ? (
                  <>
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    Disconnecting…
                  </>
                ) : (
                  "Disconnect"
                )}
              </Button>
            </div>
          </div>

          {needsWebhook && (
            <form
              onSubmit={handleSaveSecret}
              className="bg-muted/30 space-y-3 rounded-lg border p-4"
            >
              <div>
                <p className="text-sm font-medium">Finish the webhook step</p>
                <p className="text-muted-foreground mt-1 text-xs">
                  We couldn&apos;t register the webhook automatically
                  {pendingWebhook?.error ? ` (${pendingWebhook.error})` : ""}.
                  On your webinar platform go to{" "}
                  <span className="font-medium">
                    Settings → Webhooks → Add endpoint
                  </span>
                  , point it at the URL below (all events is fine), then paste
                  the signing secret here.
                </p>
              </div>
              {pendingWebhook?.url && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Endpoint URL</Label>
                  <code className="bg-background block overflow-x-auto rounded border px-2 py-1.5 text-[11px]">
                    {pendingWebhook.url}
                  </code>
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="w1-whsec">Signing secret</Label>
                <Input
                  id="w1-whsec"
                  value={manualSecret}
                  onChange={(e) => setManualSecret(e.target.value)}
                  placeholder="whsec_…"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="flex justify-end">
                <Button
                  type="submit"
                  size="sm"
                  disabled={saving || !manualSecret.trim()}
                >
                  {saving ? (
                    <>
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                      Saving…
                    </>
                  ) : (
                    "Save signing secret"
                  )}
                </Button>
              </div>
            </form>
          )}
        </div>
      ) : (
        <form onSubmit={handleConnect} className="space-y-4">
          <div className="bg-muted/30 rounded-lg border p-4">
            <p className="text-sm font-medium">Get an API key</p>
            <p className="text-muted-foreground mt-1 text-xs">
              On your Webinar1 deployment, sign in as the workspace admin and go
              to{" "}
              <span className="font-medium">
                Settings → API → Create API key
              </span>
              . The key is shown once — paste it straight in here. Connecting
              also registers the webhook that syncs registrations and attendance
              back to this CRM.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="w1-url">Platform URL</Label>
              <Input
                id="w1-url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://webinars.yourdomain.com"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="w1-key">API key</Label>
              <Input
                id="w1-key"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="wbk_…"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>
          <p className="text-muted-foreground text-[11px]">
            Stored securely and never shown again — only the first characters
            are displayed after saving.
          </p>

          <div className="flex items-center justify-end">
            <Button
              type="submit"
              size="sm"
              disabled={saving || !baseUrl.trim() || !apiKey.trim()}
            >
              {saving ? (
                <>
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  Connecting…
                </>
              ) : (
                "Connect"
              )}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
