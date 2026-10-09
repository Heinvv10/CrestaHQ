"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Timer } from "lucide-react";
import { toast } from "sonner";

import { useSubAccount } from "@/context/sub-account-context";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { MysteryShopConfirmMiss } from "./mystery-shop-confirm-miss";
import { MYSTERY_SHOP_CHANNELS, type MysteryShopChannel } from "@/lib/prospecting/mystery-shop/model";
import { shopStatusLine, type MemberShop } from "@/lib/prospecting/mystery-shop/section";

/**
 * The Reports card's Mystery shop area (Prospecting PR 5): one button per
 * channel, disabled with the server's reason when the channel cannot send.
 * Every send goes through a confirm dialog naming the channel, the exact
 * recipient (picked from the contact's own values), the full enquiry (for
 * WhatsApp, the approved template as it will read) and, for a call, the
 * operator's consent checkbox — the POST carries
 * `confirm: true` (and `consentAck`) only from there, plus the hash of the
 * enquiry shown, so the server refuses if it changed meanwhile. Renders
 * nothing for a contact that is not a prospect. An AlertDialog, never
 * window.confirm (it freezes automation).
 */

type ChannelInfo = { available: boolean; reason?: string; targets: string[] };
type ShopsResponse = {
  shops: MemberShop[];
  channels: Record<MysteryShopChannel, ChannelInfo>;
  cap: number;
  used: number;
  enquiry: { email: { subject: string; body: string }; call: string; whatsapp: string | null };
  enquiryHash: { email: string; call: string; whatsapp: string | null };
};

const LABEL: Record<MysteryShopChannel, string> = { email: "Email", call: "AI call", whatsapp: "WhatsApp", form: "Website form" };
/** Which enquiry (and hash) a channel sends; the form has none yet. */
const kindOf = (c: MysteryShopChannel) => (c === "email" || c === "whatsapp" ? c : "call");
const NO_TARGET: Record<MysteryShopChannel, string> = {
  email: "This contact has no email address.",
  call: "This contact has no valid phone number.",
  whatsapp: "This contact has no WhatsApp number.",
  form: "No contact form was found on this business's website.",
};

/** The Call dialog's consent wording (send-call-dialog.tsx). */
const CONSENT =
  "I confirm this contact has consented to receive calls from us, and that calling them now complies with the rules that apply where they are.";

async function errorOf(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? `Failed (HTTP ${res.status})`;
}

export function ContactMysteryShop({ contactId }: { contactId: string }) {
  const { subAccount, subAccountId } = useSubAccount();
  const base = `/api/sub-accounts/${subAccountId}/prospecting/mystery-shop`;
  const business = subAccount?.name ?? "this workspace";

  const [data, setData] = useState<ShopsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [consent, setConsent] = useState(false);
  const [confirming, setConfirming] = useState<{ channel: MysteryShopChannel; target: string } | null>(null);

  /** `keepError`: after a send, keep its error on screen through the refresh. */
  const load = useCallback(async (keepError = false) => {
    try {
      const res = await fetch(`${base}?contactId=${encodeURIComponent(contactId)}`);
      if (res.status === 403) {
        const body = (await res.clone().json().catch(() => ({}))) as { code?: string };
        if (body.code === "not_a_prospect") return setHidden(true);
      }
      if (!res.ok) throw new Error(await errorOf(res));
      setData((await res.json()) as ShopsResponse);
      if (!keepError) setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load mystery shops");
    }
  }, [base, contactId]);

  useEffect(() => {
    void load();
  }, [load]);

  const send = async (channel: MysteryShopChannel, target: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(base, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactId, channel, confirm: true, target,
          enquiryHash: data?.enquiryHash[kindOf(channel)],
          ...(channel === "call" ? { consentAck: consent } : {}),
        }),
      });
      if (!res.ok) throw new Error(await errorOf(res));
      // Taken by the provider but already reported undeliverable (WhatsApp).
      const sent = (await res.json().catch(() => ({}))) as { status?: string; error?: string };
      if (sent.status === "failed") throw new Error(sent.error ?? "The enquiry could not be delivered.");
      toast.success(channel === "call" ? "Mystery-shop call placed" : "Mystery-shop enquiry sent");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
      await load(true);
    }
  };

  /** A member's confirmation of a miss: only a confirmed miss appears on the public report. */
  const confirmMissed = async (shopId: string, reviewedAutoReply: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${base}/${encodeURIComponent(shopId)}/confirm-missed`, {
        method: "POST",
        ...(reviewedAutoReply ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reviewedAutoReply }) } : {}),
      });
      if (!res.ok) throw new Error(await errorOf(res));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
      await load(true);
    }
  };

  if (hidden) return null;

  const atCap = !!data && data.used >= data.cap;
  const enquiryText = (c: MysteryShopChannel) => {
    if (!data) return "";
    const kind = kindOf(c);
    return kind === "email" ? `Subject: ${data.enquiry.email.subject}\n\n${data.enquiry.email.body}` : (data.enquiry[kind] ?? "");
  };

  return (
    <div className="space-y-2 border-t pt-3" data-testid="mystery-shop">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Timer className="h-4 w-4" />
        Mystery shop
      </h3>
      <p className="text-xs text-muted-foreground">
        Send one plain enquiry from {business} and time the business&rsquo;s first human reply within 24 h.
        {data ? ` ${data.used} of ${data.cap} used this month.` : ""}
      </p>
      {data && (
        <div className="flex flex-wrap gap-2">
          {MYSTERY_SHOP_CHANNELS.map((c) => {
            const info = data.channels[c];
            const ready = info.available && info.targets.length > 0;
            return (
              <Button
                key={c}
                type="button"
                size="sm"
                variant="outline"
                disabled={!ready || atCap || busy}
                onClick={() => {
                  setConsent(false);
                  setConfirming({ channel: c, target: info.targets[0] });
                }}
                data-testid={`mystery-shop-${c}`}
              >
                {LABEL[c]}
              </Button>
            );
          })}
        </div>
      )}
      {data &&
        MYSTERY_SHOP_CHANNELS.map((c) => {
          const info = data.channels[c];
          const why = !info.available ? info.reason : info.targets.length === 0 ? NO_TARGET[c] : null;
          return why ? (
            <p key={c} className="text-xs text-muted-foreground" data-testid={`mystery-shop-${c}-reason`}>
              {LABEL[c]}: {why}
            </p>
          ) : null;
        })}
      {busy && (
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" /> Sending…
        </p>
      )}
      {atCap && <p className="text-xs text-muted-foreground">This month&rsquo;s mystery-shop limit is used up.</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {error && !data && (
        <Button type="button" size="sm" variant="outline" onClick={() => void load()} data-testid="mystery-shop-retry">
          Retry
        </Button>
      )}
      {data?.shops.map((s) => (
        <div key={s.id} className="space-y-1">
          <p className="text-xs" data-testid={`mystery-shop-status-${s.id}`}>
            {shopStatusLine(s, Date.now())}
          </p>
          <MysteryShopConfirmMiss shop={s} busy={busy} onConfirm={(reviewed) => void confirmMissed(s.id, reviewed)} />
        </div>
      ))}

      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent data-testid="mystery-shop-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming?.channel === "call"
                ? "Place a mystery-shop AI call?"
                : `Send a mystery-shop ${confirming?.channel === "whatsapp" ? "WhatsApp" : LABEL[confirming?.channel ?? "email"].toLowerCase()}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Channel: {confirming ? LABEL[confirming.channel] : ""}. This contacts the business for real, from {business}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirming && data && (
            <div className="space-y-3 text-sm">
              <div>
                <p className="font-medium">To</p>
                {data.channels[confirming.channel].targets.map((t) => (
                  <label key={t} className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="mystery-shop-target"
                      checked={confirming.target === t}
                      onChange={() => setConfirming({ ...confirming, target: t })}
                    />
                    <span data-testid="mystery-shop-target">{t}</span>
                  </label>
                ))}
              </div>
              <div>
                <p className="font-medium">Enquiry</p>
                <p className="whitespace-pre-wrap rounded bg-muted px-2 py-1 text-xs" data-testid="mystery-shop-enquiry">
                  {enquiryText(confirming.channel)}
                </p>
              </div>
              {confirming.channel === "call" && (
                <>
                  <p className="text-xs" data-testid="mystery-shop-consent">
                    I confirm {business} may place this AI call to {confirming.target} now.
                  </p>
                  <label
                    className="flex items-start gap-2.5 rounded-lg border bg-muted/30 p-3 text-xs"
                    data-testid="mystery-shop-consent-ack"
                  >
                    <input
                      type="checkbox"
                      checked={consent}
                      onChange={(e) => setConsent(e.target.checked)}
                      className="mt-0.5 h-4 w-4 cursor-pointer"
                    />
                    <span>{CONSENT}</span>
                  </label>
                </>
              )}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="mystery-shop-confirm-send"
              disabled={confirming?.channel === "call" && !consent}
              onClick={() => {
                const c = confirming;
                setConfirming(null);
                if (c) void send(c.channel, c.target);
              }}
            >
              {confirming?.channel === "call" ? "Place the call" : "Send the enquiry"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
