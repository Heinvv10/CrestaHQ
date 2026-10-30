"use client";

import Link from "next/link";
import { AlertTriangle, CreditCard, Loader2, Lock } from "lucide-react";
import { usePayUsageCharge } from "@/hooks/use-pay-usage-charge";
import { Button } from "@/components/ui/button";
import { formatBillingPrice } from "@/lib/billing/status";
import { usageGraceEndsAt } from "@/lib/billing/usage-debt";
import { formatUsageMonth } from "@/lib/billing/usage";
import type { UsageOverdue } from "@/types/tenancy";

/** The agency notice and the usage banner and paywall the workspace guard shows (billing-guard.tsx). */

export function AgencyBillingNotice({
  state,
  usage,
  paywall,
}: {
  state: "pending" | "grace" | "lapsed";
  usage: boolean;
  paywall: boolean;
}) {
  const copy = usage
    ? state === "grace"
      ? paywall
        ? "This client has an overdue usage charge: members see a payment banner until the grace period ends."
        : "This client has an overdue usage charge: members see a payment banner. The usage paywall is off, so their access is never paused."
      : "This client's usage charge is unpaid past the grace period: members are behind the paywall. You still have full access."
    : state === "pending"
      ? "This client hasn't completed checkout yet — members see an activation screen."
      : state === "grace"
        ? "This client's payment failed — members see a payment banner until the grace period ends."
        : "This client's billing lapsed — members are behind the paywall. You still have full access.";
  return (
    <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      <span>
        {copy}{" "}
        <Link href="/agency/billing" className="font-medium underline">
          Manage in Client billing
        </Link>
      </span>
    </div>
  );
}

/** One usage charge, straight to checkout (admins only; the route re-checks). */
function usePayOverdue(subAccountId: string, chargeId: string) {
  const { paying, pay } = usePayUsageCharge(subAccountId);
  return { redirecting: paying !== null, pay: () => pay(chargeId) };
}

function usageLabel(overdue: UsageOverdue): string {
  const amount = formatBillingPrice(overdue.amountCents, overdue.currency);
  return overdue.usageMonth
    ? `${amount} for ${formatUsageMonth(overdue.usageMonth)}`
    : amount;
}

export function UsageBanner({
  subAccountId,
  isAdmin,
  overdue,
}: {
  subAccountId: string;
  isAdmin: boolean;
  overdue: UsageOverdue;
}) {
  const { redirecting, pay } = usePayOverdue(subAccountId, overdue.chargeId);
  // Null while the wall is off: a banner that promised a pause would be a lie.
  const endsAt = usageGraceEndsAt(overdue);
  const daysLeft =
    endsAt !== null ? Math.max(0, Math.ceil((endsAt - Date.now()) / 86_400_000)) : null;
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-300">
      <span className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span>
          Usage invoice overdue ({usageLabel(overdue)}).
          {daysLeft !== null && (
            <>
              {" "}
              Access pauses in{" "}
              <strong>
                {daysLeft} day{daysLeft === 1 ? "" : "s"}
              </strong>{" "}
              unless it&apos;s paid.
            </>
          )}
        </span>
      </span>
      {isAdmin && (
        <Button type="button" size="sm" className="h-7 px-3 text-xs" onClick={pay} disabled={redirecting}>
          {redirecting ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <CreditCard className="mr-1 h-3 w-3" />
          )}
          Pay now
        </Button>
      )}
    </div>
  );
}

export function UsagePaywall({
  subAccountId,
  isAdmin,
  overdue,
}: {
  subAccountId: string;
  isAdmin: boolean;
  overdue: UsageOverdue;
}) {
  const { redirecting, pay } = usePayOverdue(subAccountId, overdue.chargeId);
  return (
    <div className="flex min-h-[70vh] items-center justify-center px-6">
      <div className="w-full max-w-md rounded-2xl border bg-card p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
          <Lock className="h-5 w-5 text-primary" />
        </div>
        <h1 className="text-xl font-semibold">Usage invoice unpaid</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          The usage charge for this workspace ({usageLabel(overdue)}) is past
          due, so access is paused. All your data is safe — paying restores
          everything instantly.
        </p>
        {isAdmin ? (
          <Button className="mt-6" onClick={pay} disabled={redirecting}>
            {redirecting ? (
              <>
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                Opening checkout…
              </>
            ) : (
              <>
                <CreditCard className="mr-1.5 h-4 w-4" />
                Pay &amp; restore access
              </>
            )}
          </Button>
        ) : (
          <p className="mt-6 text-sm text-muted-foreground">
            Ask your workspace admin to pay the usage invoice.
          </p>
        )}
        <p className="mt-4 text-xs text-muted-foreground">
          Payments are processed securely by our payment provider. Your card isn&apos;t saved.
        </p>
      </div>
    </div>
  );
}
