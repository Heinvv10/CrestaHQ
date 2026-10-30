"use client";

import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, CreditCard, Loader2 } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Sub-account Paystack settings — the South African card rail.
 *
 * The operator pastes their own Paystack SECRET key. Money from their customers
 * lands in THEIR Paystack; the agency never touches it and takes no cut. This
 * card exists alongside the Stripe one because Stripe does not serve SA
 * merchants for payouts, so for most operators here Stripe is not an option.
 *
 * Note the inversion against the Stripe card: there we refuse `sk_…` and demand
 * a restricted key. Paystack has no restricted keys — secret and public are the
 * only two — so the secret key is the credential and a pasted `pk_…` is the
 * mistake to catch.
 *
 * The key is never rendered back: the server stores it in a locked
 * subcollection and this card reads only `paystackConnectionMeta` (last 4,
 * currencies, livemode) off the sub-account doc.
 *
 * Self-gating like the Stripe card — renders nothing unless the caller is an
 * admin AND the agency has turned the Payments gate on.
 */
export function SubAccountPaystackSection() {
  const { subAccountId, subAccount, isAdmin } = useSubAccount();
  const meta = subAccount?.paystackConnectionMeta ?? null;

  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  if (!isAdmin) return null;
  if (subAccount?.paymentsEnabledByAgency !== true) return null;

  async function post(): Promise<void> {
    const res = await fetch(
      `/api/sub-accounts/${subAccountId}/paystack-connection`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secretKey: key.trim() }),
      },
    );
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
    };
    if (!res.ok || !data.ok) {
      throw new Error(data.error ?? "Couldn't connect Paystack.");
    }
  }

  async function handleConnect(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await post();
      setKey("");
      toast.success("Paystack connected — now add the webhook URL below.");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't connect Paystack.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDisconnect() {
    if (
      !confirm(
        "Disconnect Paystack? New payments can't be taken until you reconnect. Payments already made are unaffected — they live in your Paystack account.",
      )
    ) {
      return;
    }
    setDisconnecting(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/paystack-connection`,
        { method: "DELETE" },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Failed to disconnect.");
      }
      toast.success("Paystack disconnected.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to disconnect.");
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <section className="rounded-2xl border bg-card p-6">
      <header className="mb-4 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-400">
          <CreditCard className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">Payments — Paystack</h2>
            {meta && !meta.livemode && (
              <span className="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
                Test mode
              </span>
            )}
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Connect your own Paystack account to take card payments in ZAR from
            your customers. Money goes directly to your Paystack — it never
            passes through your agency, and no cut is taken.
          </p>
        </div>
      </header>

      {meta ? (
        <div className="space-y-3">
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
            <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4" />
              Connected
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              Secret key ending {meta.keyLast4 ?? "••••"}
              {meta.currencies.length > 0
                ? ` · ${meta.currencies.join(", ")}`
                : ""}
              {!meta.livemode ? " · test mode — no real money will move" : ""}
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

          {/* Paystack has no API for creating a webhook endpoint, so this step
              is always manual and the card can only report what it has actually
              seen arrive — never a guess that the paste was done. */}
          <div
            className={
              meta.webhookSeenAt
                ? "rounded-lg border bg-muted/30 p-4"
                : "rounded-lg border border-amber-500/30 bg-amber-500/5 p-4"
            }
          >
            {meta.webhookSeenAt ? (
              <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="h-4 w-4" />
                Webhook confirmed — an event has arrived and verified.
              </p>
            ) : (
              <p className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-4 w-4" />
                No webhook received yet
              </p>
            )}
            <p className="mt-1 text-xs text-muted-foreground">
              Paystack can&apos;t register a webhook for you, so add it by hand:{" "}
              <span className="font-medium">
                Paystack → Settings → API Keys &amp; Webhooks
              </span>
              . Paste the URL below into the{" "}
              <span className="font-medium">Webhook URL</span> field. Until an
              event arrives, we can&apos;t tell whether it was done.
            </p>
            {meta.webhookUrl && (
              <code className="mt-2 block overflow-x-auto rounded border bg-background px-2 py-1.5 text-[11px]">
                {meta.webhookUrl}
              </code>
            )}
          </div>
        </div>
      ) : (
        <form onSubmit={handleConnect} className="space-y-4">
          <div className="rounded-lg border bg-muted/30 p-4">
            <p className="text-sm font-medium">Copy your secret key</p>
            <p className="mt-1 text-xs text-muted-foreground">
              In Paystack:{" "}
              <span className="font-medium">
                Settings → API Keys &amp; Webhooks → Secret Key
              </span>
              . It starts with <code>sk_live_</code>. Paystack has no
              restricted-key option — the secret key is the only credential that
              can take payments, so it is the one to paste. Testing? Flip
              Paystack to test mode first and use the <code>sk_test_…</code> key;
              nothing charges for real.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="paystack-sk">Secret key</Label>
            <Input
              id="paystack-sk"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="sk_live_… or sk_test_…"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-[11px] text-muted-foreground">
              Stored securely and never shown again — only the last 4 characters
              are displayed after saving. Paste the public key (<code>pk_…</code>
              ) and we&apos;ll tell you.
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
                "Connect Paystack"
              )}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
