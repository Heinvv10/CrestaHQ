"use client";

import { useState } from "react";
import { toast } from "sonner";
import { CreditCard, Loader2 } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { BillingStatusBadge } from "@/components/agency/billing-status-badge";
import {
  effectiveBillingState,
  formatBillingPriceWithInterval,
} from "@/lib/billing/status";

/**
 * "Your subscription" card in sub-account settings (Client Billing v1).
 * Self-gating: renders ONLY when this workspace is billed through the
 * platform (billing present and not comped) — comped/legacy workspaces see
 * nothing, exactly as before the feature shipped.
 *
 * Admin actions: open the Stripe Billing Portal (card changes, invoices)
 * or complete checkout when payment is still owed.
 */
export function SubAccountPlanBillingSection() {
  const { subAccountId, subAccount, isAdmin } = useSubAccount();
  const [busy, setBusy] = useState<null | "portal" | "checkout">(null);

  const billing = subAccount?.billing ?? null;
  const state = effectiveBillingState(billing);
  if (!billing || state === "comped") return null;

  const priceLabel = formatBillingPriceWithInterval(
    billing.priceCents,
    billing.currency,
    billing.billingInterval,
  );
  const cadenceWord = billing.billingInterval === "year" ? "annually" : "monthly";
  const needsPayment = state === "pending" || state === "lapsed";

  async function open(path: "portal" | "checkout") {
    setBusy(path);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/billing/${path}`,
        { method: "POST" },
      );
      const data = (await res.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
      };
      if (!res.ok || !data.url) {
        throw new Error(data.error ?? "Something went wrong.");
      }
      window.location.href = data.url;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Something went wrong.");
      setBusy(null);
    }
  }

  return (
    <section className="rounded-2xl border bg-card p-6">
      <header className="mb-4 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
          <CreditCard className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            Your subscription
            <BillingStatusBadge billing={billing} />
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {billing.planName ? (
              <>
                <span className="font-medium text-foreground">
                  {billing.planName}
                </span>{" "}
                — {priceLabel}, billed automatically.
              </>
            ) : (
              `This workspace is billed ${cadenceWord}.`
            )}
          </p>
        </div>
      </header>

      {isAdmin ? (
        <div className="flex flex-wrap items-center gap-2">
          {needsPayment && (
            <Button
              type="button"
              size="sm"
              onClick={() => open("checkout")}
              disabled={busy !== null}
            >
              {busy === "checkout" ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : null}
              {state === "pending" ? "Complete checkout" : "Pay & restore access"}
            </Button>
          )}
          {billing.stripeCustomerId && (
            <Button
              type="button"
              size="sm"
              variant={needsPayment ? "outline" : "default"}
              onClick={() => open("portal")}
              disabled={busy !== null}
            >
              {busy === "portal" ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : null}
              Manage billing
            </Button>
          )}
          <p className="w-full text-xs text-muted-foreground sm:w-auto">
            Card changes and invoices are handled on Stripe&apos;s secure
            portal.
          </p>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Billing is managed by your workspace admin.
        </p>
      )}
    </section>
  );
}
