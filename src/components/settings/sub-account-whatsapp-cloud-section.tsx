"use client";

import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { CheckCircle2, Loader2, MessageCircle } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { resolveWhatsAppProviderId } from "@/lib/comms/whatsapp/provider";

/**
 * Sub-account WhatsApp Cloud settings — the `cloud` arm of the provider seam.
 *
 * The operator pastes their own WABA's phone-number id, business-account id
 * and access token. The token is never rendered back: the server stores it in
 * the locked `private/` subcollection and this card reads only the non-secret
 * `whatsappCloudMeta` off the sub-account doc.
 *
 * Unlike the Stripe card, connecting here has a side effect the operator MUST
 * understand: it moves this workspace's live WhatsApp sending onto the Cloud
 * rail. Existing conversations keep working, but templates approved through
 * Twilio do not carry over — approval belongs to a WABA, and this is a
 * different one. The copy says so rather than burying it.
 *
 * Self-gating, like the Stripe and Meta cards: renders nothing unless the
 * caller is an admin and the agency has turned the WhatsApp gate on.
 */
export function SubAccountWhatsappCloudSection() {
  const { subAccountId, subAccount, isAdmin } = useSubAccount();
  const meta = subAccount?.whatsappCloudMeta ?? null;
  const connected = !!meta?.phoneNumberId;
  const provider = resolveWhatsAppProviderId(subAccount?.whatsappProvider);

  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [wabaId, setWabaId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  if (!isAdmin) return null;
  if (subAccount?.whatsappEnabledByAgency !== true) return null;

  const webhookUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/webhooks/whatsapp-cloud`
      : "/api/webhooks/whatsapp-cloud";

  async function handleConnect(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/whatsapp-cloud-connection`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            phoneNumberId: phoneNumberId.trim(),
            wabaId: wabaId.trim(),
            accessToken: accessToken.trim(),
          }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        displayPhoneNumber?: string | null;
        verifiedName?: string | null;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Couldn't connect WhatsApp Cloud.");
      }
      setPhoneNumberId("");
      setWabaId("");
      setAccessToken("");
      toast.success(
        data.displayPhoneNumber
          ? `Connected — sending from ${data.displayPhoneNumber}`
          : "WhatsApp Cloud connected.",
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't connect WhatsApp Cloud.",
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDisconnect() {
    if (
      !confirm(
        "Disconnect WhatsApp Cloud? This workspace returns to sending over Twilio. Message history is kept, but templates approved on the Cloud account will need re-approving if you reconnect later.",
      )
    ) {
      return;
    }
    setDisconnecting(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/whatsapp-cloud-connection`,
        { method: "DELETE" },
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Failed to disconnect.");
      }
      toast.success("Disconnected — back to sending over Twilio.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to disconnect.");
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <section className="rounded-2xl border bg-card p-6">
      <header className="mb-4 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
          <MessageCircle className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">
              WhatsApp — Meta Cloud API
            </h2>
            <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Sending via {provider}
            </span>
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Send WhatsApp through your own Meta account instead of Twilio.
            Cheaper per message, and you own the sender. Connecting switches
            this workspace&apos;s WhatsApp sending over — it is reversible at
            any time.
          </p>
        </div>
      </header>

      {connected ? (
        <div className="space-y-3">
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
            <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4" />
              Connected
              {meta?.verifiedName ? (
                <span className="font-semibold">as {meta.verifiedName}</span>
              ) : null}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              {meta?.displayPhoneNumber ?? "Number unavailable"}
              {meta?.phoneNumberId ? ` · ID ${meta.phoneNumberId}` : ""}
            </p>
            {/* Unreachable today: connect sets both the credentials and the
                provider, disconnect clears both, so the two cannot disagree.
                Kept for the `bridge` rail (1.2b), which will be selectable
                without clearing a stored Cloud connection. Labelled rather
                than deleted so nobody later reads it as a live state. */}
            {provider !== "cloud" && (
              <p className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-400">
                Credentials are stored, but this workspace is currently sending
                over {provider}. Inbound messages to this number are ignored
                until it is switched back to Cloud.
              </p>
            )}
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

          <div className="rounded-lg border bg-muted/30 p-4">
            <p className="text-sm font-medium">Webhook</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Register this URL in your Meta app under WhatsApp → Configuration,
              subscribed to the <code>messages</code> field. Without it, replies
              from customers never reach this CRM.
            </p>
            <code className="mt-2 block overflow-x-auto rounded bg-background px-2 py-1.5 text-xs">
              {webhookUrl}
            </code>
          </div>
        </div>
      ) : (
        <form onSubmit={handleConnect} className="space-y-3">
          <div className="rounded-lg border bg-muted/30 p-4 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">Before you connect</p>
            <p className="mt-1">
              Find these in Meta&apos;s WhatsApp Manager. The{" "}
              <strong>phone number ID</strong> and the{" "}
              <strong>WhatsApp Business Account ID</strong> sit next to each
              other and are easy to mix up — we check both against Meta before
              saving, so a swap is caught here rather than at send time.
            </p>
            <p className="mt-2">
              Templates approved through Twilio do{" "}
              <strong>not</strong> carry over: approval belongs to a WhatsApp
              Business Account, and this is a different one. Re-submit them from
              AI Agents → WhatsApp → Templates after connecting.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="wa-cloud-pn">Phone number ID</Label>
              <Input
                id="wa-cloud-pn"
                value={phoneNumberId}
                onChange={(e) => setPhoneNumberId(e.target.value)}
                placeholder="123456789012345"
                autoComplete="off"
                required
              />
            </div>
            <div>
              <Label htmlFor="wa-cloud-waba">WhatsApp Business Account ID</Label>
              <Input
                id="wa-cloud-waba"
                value={wabaId}
                onChange={(e) => setWabaId(e.target.value)}
                placeholder="098765432109876"
                autoComplete="off"
                required
              />
            </div>
          </div>
          <div>
            <Label htmlFor="wa-cloud-token">Access token</Label>
            <Input
              id="wa-cloud-token"
              type="password"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              placeholder="EAAG…"
              autoComplete="off"
              required
            />
            <p className="mt-1 text-xs text-muted-foreground">
              A system-user token with{" "}
              <code>whatsapp_business_messaging</code> and{" "}
              <code>whatsapp_business_management</code>. Stored server-side and
              never shown again.
            </p>
          </div>
          <div className="flex justify-end">
            <Button type="submit" disabled={saving}>
              {saving ? (
                <>
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  Verifying with Meta…
                </>
              ) : (
                "Connect & switch to Cloud"
              )}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
