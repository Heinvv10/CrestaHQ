"use client";

import { useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";

/**
 * Starts a one-time purchase (group access or a course), then surfaces the
 * paypal.me link to pay at. v1 is manual-reconcile: after paying, a staff admin
 * marks the purchase paid to grant access. Used on the About page (group) and
 * the classroom catalog (course).
 */
export function PurchaseButton({
  saId,
  groupId,
  scope,
  targetId,
  label,
  brand,
  className,
}: {
  saId: string;
  groupId: string;
  scope: "group" | "course";
  targetId: string;
  label: string;
  brand: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState<{
    purchaseId: string;
    paypalUrl: string;
    cardAvailable: boolean;
  } | null>(null);
  const [payingCard, setPayingCard] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/community/${saId}/${groupId}/purchase`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, targetId }),
      });
      const d = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        purchaseId?: string;
        paypalUrl?: string;
        cardAvailable?: boolean;
        error?: string;
      };
      // A purchase is now valid with EITHER rail, so the old
      // "no paypalUrl means failure" check would break card-only workspaces.
      if (!res.ok || !d.ok || !d.purchaseId) {
        throw new Error(d.error ?? "Couldn't start purchase");
      }
      setStarted({
        purchaseId: d.purchaseId,
        paypalUrl: d.paypalUrl ?? "",
        cardAvailable: d.cardAvailable === true,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start purchase");
    } finally {
      setBusy(false);
    }
  }

  /** Payments v1 — hand off to Stripe. Access unlocks automatically on the
   *  webhook, unlike the PayPal path which waits on a staff admin. */
  async function payByCard(purchaseId: string) {
    setPayingCard(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/community/${saId}/${groupId}/purchase/${purchaseId}/pay`,
        { method: "POST" },
      );
      const d = (await res.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
      };
      if (!res.ok || !d.url) {
        throw new Error(d.error ?? "Couldn't start checkout");
      }
      window.location.href = d.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't start checkout");
      setPayingCard(false);
    }
  }

  if (started) {
    return (
      <div className="space-y-1.5">
        {started.cardAvailable && (
          <button
            onClick={() => payByCard(started.purchaseId)}
            disabled={payingCard}
            className={
              className ??
              "inline-flex w-full items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
            }
            style={{ backgroundColor: brand }}
          >
            {payingCard && <Loader2 className="h-4 w-4 animate-spin" />}
            Pay by card
          </button>
        )}
        {/* PayPal unchanged — sole option when card isn't available. */}
        {started.paypalUrl && (
          <a
            href={started.paypalUrl}
            target="_blank"
            rel="noreferrer"
            className={
              started.cardAvailable
                ? "inline-flex w-full items-center justify-center gap-2 rounded-md border border-[#3a3a3a] px-4 py-2.5 text-sm font-semibold"
                : (className ??
                  "inline-flex w-full items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-semibold text-white")
            }
            style={
              started.cardAvailable ? undefined : { backgroundColor: brand }
            }
          >
            Pay on PayPal <ExternalLink className="h-4 w-4" />
          </a>
        )}
        <p className="text-center text-xs text-[#909090]">
          {started.cardAvailable
            ? "Card payments unlock your access straight away. PayPal is confirmed by the group owner."
            : "After you pay, the group owner confirms it and unlocks your access."}
        </p>
        {error && <p className="text-center text-xs text-destructive">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <button
        onClick={start}
        disabled={busy}
        className={
          className ??
          "inline-flex w-full items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
        }
        style={{ backgroundColor: brand }}
      >
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}
        {label}
      </button>
      {error && <p className="text-center text-xs text-destructive">{error}</p>}
    </div>
  );
}
