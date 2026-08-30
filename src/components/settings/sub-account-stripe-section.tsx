"use client";

import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  CreditCard,
  Loader2,
} from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Sub-account Stripe settings — Payments v1 (Tier 1, bring-your-own key).
 *
 * The operator pastes a Stripe RESTRICTED key from their own Stripe account.
 * Money from their customers lands in THEIR Stripe; the agency never touches
 * it and takes no cut. (Stripe Connect — which would let an agency take an
 * application fee — is Tier 2 and deliberately not built. See
 * PAYMENTS_V1_PLAN.md.)
 *
 * The key is never rendered back: the server stores it in a locked
 * subcollection and this card reads only `stripeConnectionMeta` (last 4,
 * account name, livemode) off the sub-account doc.
 *
 * Self-gating like the Meta card — renders nothing unless the caller is an
 * admin AND the agency has turned the Payments gate on.
 */

/**
 * Restricted-key permissions this integration actually needs.
 *
 * Products and Prices must be WRITE, not read: a Checkout Session built from
 * inline `price_data` creates a Price (and its Product) on the fly. With
 * read-only access Stripe rejects the call at payment time — the connection
 * itself still succeeds, so the failure only shows up when a customer tries to
 * pay. Learned the hard way; don't downgrade these.
 */
const SCOPES: { label: string; detail: string }[] = [
  { label: "Checkout Sessions", detail: "Write" },
  { label: "PaymentIntents", detail: "Write" },
  { label: "Products", detail: "Write" },
  { label: "Prices", detail: "Write" },
  { label: "Refunds", detail: "Write" },
  { label: "Webhook Endpoints", detail: "Write" },
  { label: "Account", detail: "Read" },
];

export function SubAccountStripeSection() {
  const { subAccountId, subAccount, isAdmin } = useSubAccount();
  const meta = subAccount?.stripeConnectionMeta ?? null;
  const connected = !!meta;

  const [key, setKey] = useState("");
  const [manualSecret, setManualSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  // Only populated when auto-registration failed — drives the manual panel.
  const [pendingWebhook, setPendingWebhook] = useState<{
    url: string | null;
    events: string[] | null;
    error: string | null;
  } | null>(null);

  if (!isAdmin) return null;
  if (subAccount?.paymentsEnabledByAgency !== true) return null;

  async function handleConnect(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/stripe-connection`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ restrictedKey: key.trim() }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        ready?: boolean;
        accountName?: string | null;
        webhookUrl?: string | null;
        webhookEvents?: string[] | null;
        webhookError?: string | null;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Couldn't connect Stripe.");
      }
      setKey("");
      if (data.ready) {
        setPendingWebhook(null);
        toast.success(
          data.accountName
            ? `Stripe connected — ${data.accountName}`
            : "Stripe connected.",
        );
      } else {
        setPendingWebhook({
          url: data.webhookUrl ?? null,
          events: data.webhookEvents ?? null,
          error: data.webhookError ?? null,
        });
        toast.warning("Stripe connected — one more step to receive payments.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't connect Stripe.");
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveSecret(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/stripe-connection`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ webhookSecret: manualSecret.trim() }),
        },
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
      toast.success("Webhook connected — you're ready to take payments.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save.");
    } finally {
      setSaving(false);
    }
  }

  async function handleDisconnect() {
    if (
      !confirm(
        "Disconnect Stripe? New payments can't be taken until you reconnect. Payments already made are unaffected — they live in your Stripe account.",
      )
    ) {
      return;
    }
    setDisconnecting(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/stripe-connection`,
        { method: "DELETE" },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Failed to disconnect.");
      }
      setPendingWebhook(null);
      toast.success("Stripe disconnected.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to disconnect.");
    } finally {
      setDisconnecting(false);
    }
  }

  const needsWebhook = connected && meta && !meta.ready;

  return (
    <section className="rounded-2xl border bg-card p-6">
      <header className="mb-4 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
          <CreditCard className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">Payments — Stripe</h2>
            {connected && !meta!.livemode && (
              <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
                Test mode
              </span>
            )}
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Connect your own Stripe account to take card payments from your
            customers. Money goes directly to your Stripe — it never passes
            through your agency, and no cut is taken.
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
                Connected — but payments can&apos;t be confirmed yet
              </p>
            ) : (
              <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="h-4 w-4" />
                Connected
                {meta!.accountName ? (
                  <span className="font-semibold">to {meta!.accountName}</span>
                ) : null}
              </p>
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              Restricted key ending {meta!.keyLast4 ?? "••••"}
              {meta!.accountId ? ` · ${meta!.accountId}` : ""}
              {!meta!.livemode
                ? " · test mode — no real money will move"
                : ""}
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
              className="space-y-3 rounded-lg border bg-muted/30 p-4"
            >
              <div>
                <p className="text-sm font-medium">Finish the webhook step</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  We couldn&apos;t create the webhook automatically
                  {pendingWebhook?.error ? ` (${pendingWebhook.error})` : ""}.
                  Without it, a customer could pay and the order would never be
                  marked paid — so checkout stays switched off until this is
                  done. In Stripe go to{" "}
                  <span className="font-medium">
                    Developers → Webhooks → Add endpoint
                  </span>
                  , then paste the signing secret below.
                </p>
              </div>
              {pendingWebhook?.url && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Endpoint URL</Label>
                  <code className="block overflow-x-auto rounded border bg-background px-2 py-1.5 text-[11px]">
                    {pendingWebhook.url}
                  </code>
                </div>
              )}
              {pendingWebhook?.events && (
                <div className="space-y-1.5">
                  <Label className="text-xs">Events to send</Label>
                  <code className="block overflow-x-auto rounded border bg-background px-2 py-1.5 text-[11px]">
                    {pendingWebhook.events.join(", ")}
                  </code>
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="stripe-whsec">Signing secret</Label>
                <Input
                  id="stripe-whsec"
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
          <div className="rounded-lg border bg-muted/30 p-4">
            <p className="text-sm font-medium">Create a restricted key</p>
            <p className="mt-1 text-xs text-muted-foreground">
              In Stripe: <span className="font-medium">Developers → API keys
              → Create restricted key</span>. Give it these permissions and
              nothing else — a restricted key can take payments into your
              account but can&apos;t move money out of it or read your customer
              list.
            </p>
            <ul className="mt-3 grid gap-1 sm:grid-cols-2">
              {SCOPES.map((s) => (
                <li
                  key={s.label}
                  className="flex items-center justify-between gap-2 rounded border bg-background px-2 py-1 text-[11px]"
                >
                  <span>{s.label}</span>
                  <span className="font-semibold text-muted-foreground">
                    {s.detail}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[11px] text-muted-foreground">
              Testing? Flip Stripe to <span className="font-medium">Test
              mode</span> first and create the key there — you&apos;ll get an{" "}
              <code>rk_test_…</code> key and nothing charges for real.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="stripe-rk">Restricted key</Label>
            <Input
              id="stripe-rk"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="rk_live_… or rk_test_…"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-[11px] text-muted-foreground">
              Stored securely and never shown again — only the last 4 characters
              are displayed after saving. Paste a full secret key (
              <code>sk_…</code>) and we&apos;ll refuse it.
            </p>
          </div>

          <div className="flex items-center justify-end gap-3">
            <Button type="submit" size="sm" disabled={saving || !key.trim()}>
              {saving ? (
                <>
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  Connecting…
                </>
              ) : (
                "Connect Stripe"
              )}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
