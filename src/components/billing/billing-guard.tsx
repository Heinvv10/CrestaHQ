"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { AlertTriangle, CreditCard, Loader2, Lock } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useSubAccount } from "@/context/sub-account-context";
import { usePayUsageCharge } from "@/hooks/use-pay-usage-charge";
import { Button } from "@/components/ui/button";
import {
  billingDateToMillis,
  formatBillingPrice,
  formatBillingPriceWithInterval,
} from "@/lib/billing/status";
import { usageGraceEndsAt, workspaceBillingState } from "@/lib/billing/usage-debt";
import { formatUsageMonth } from "@/lib/billing/usage";
import type { UsageOverdue } from "@/types/tenancy";

/**
 * Client Billing v1 workspace guard. Mounted inside <SubAccountProvider/>
 * around every /sa/[id]/* page, it derives the effective billing state from
 * the live sub-account doc at render time (no cron):
 *
 *   comped / active → children untouched (the default for every workspace)
 *   grace           → children + a dunning banner
 *   pending         → activation screen (pay-to-start), GHL "on hold" style
 *   lapsed          → hard paywall (pay-to-continue); data preserved
 *
 * Unpaid usage follows the same grace-then-paywall path, even for a comped
 * workspace, but only when the server has flagged it (`usageOverdue`: both
 * rebilling switches on, the invoice emailed, past due) and the wall itself
 * only when the agency has turned it on (`usageOverdue.paywall`). Otherwise it
 * stays a banner. Fails open: see lib/billing/usage-debt.ts.
 *
 * The AGENCY side always passes: the agency owner sees a slim notice instead
 * of the wall, so they can service a delinquent client's workspace.
 */

export function BillingGuard({ children }: { children: ReactNode }) {
  const { subAccount, subAccountId, loading, isAdmin } = useSubAccount();
  const { agencyId, agencyRole } = useAuth();

  // While loading (or if the doc is missing — pages render their own
  // not-found states) let everything through untouched.
  if (loading || !subAccount) return <>{children}</>;

  const { state, blockedBy } = workspaceBillingState(
    subAccount.billing,
    subAccount.usageOverdue,
  );
  if (state === "comped" || state === "active") return <>{children}</>;

  const isAgencySide =
    agencyRole === "owner" && subAccount.agencyId === agencyId;

  if (isAgencySide) {
    // Never wall the agency out of their own client's workspace.
    return (
      <>
        <AgencyBillingNotice
          state={state}
          usage={blockedBy === "usage"}
          paywall={subAccount.usageOverdue?.paywall === true}
        />
        {children}
      </>
    );
  }

  const overdue = subAccount.usageOverdue ?? null;
  if (blockedBy === "usage" && overdue) {
    if (state === "grace") {
      return (
        <>
          <UsageBanner subAccountId={subAccountId} isAdmin={isAdmin} overdue={overdue} />
          {children}
        </>
      );
    }
    return <UsagePaywall subAccountId={subAccountId} isAdmin={isAdmin} overdue={overdue} />;
  }

  if (state === "grace") {
    return (
      <>
        <DunningBanner
          subAccountId={subAccountId}
          isAdmin={isAdmin}
          graceUntil={billingDateToMillis(subAccount.billing?.graceUntil ?? null)}
        />
        {children}
      </>
    );
  }

  // pending | lapsed → full-screen block for sub-account members.
  return (
    <Paywall
      subAccountId={subAccountId}
      isAdmin={isAdmin}
      mode={state}
      planName={subAccount.billing?.planName ?? null}
      priceLabel={formatBillingPriceWithInterval(
        subAccount.billing?.priceCents,
        subAccount.billing?.currency,
        subAccount.billing?.billingInterval,
      )}
    />
  );
}

function AgencyBillingNotice({
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

function UsageBanner({
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

function UsagePaywall({
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

function useStartCheckout(subAccountId: string) {
  const [redirecting, setRedirecting] = useState(false);
  async function startCheckout() {
    setRedirecting(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/billing/checkout`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
      };
      if (!res.ok || !data.url) {
        throw new Error(data.error ?? "Couldn't start checkout.");
      }
      window.location.href = data.url;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't start checkout.");
      setRedirecting(false);
    }
  }
  return { redirecting, startCheckout };
}

function DunningBanner({
  subAccountId,
  isAdmin,
  graceUntil,
}: {
  subAccountId: string;
  isAdmin: boolean;
  graceUntil: number | null;
}) {
  const [opening, setOpening] = useState(false);
  const daysLeft =
    graceUntil !== null
      ? Math.max(0, Math.ceil((graceUntil - Date.now()) / 86_400_000))
      : null;

  async function openPortal() {
    setOpening(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/billing/portal`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
      };
      if (!res.ok || !data.url) {
        throw new Error(data.error ?? "Couldn't open the billing portal.");
      }
      window.location.href = data.url;
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't open the billing portal.",
      );
      setOpening(false);
    }
  }

  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-300">
      <span className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span>
          Your subscription payment failed.
          {daysLeft !== null && (
            <>
              {" "}
              Access pauses in{" "}
              <strong>
                {daysLeft} day{daysLeft === 1 ? "" : "s"}
              </strong>{" "}
              unless the card is updated.
            </>
          )}
        </span>
      </span>
      {isAdmin && (
        <Button
          type="button"
          size="sm"
          className="h-7 px-3 text-xs"
          onClick={openPortal}
          disabled={opening}
        >
          {opening ? (
            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
          ) : (
            <CreditCard className="mr-1 h-3 w-3" />
          )}
          Update card
        </Button>
      )}
    </div>
  );
}

function Paywall({
  subAccountId,
  isAdmin,
  mode,
  planName,
  priceLabel,
}: {
  subAccountId: string;
  isAdmin: boolean;
  mode: "pending" | "lapsed";
  planName: string | null;
  priceLabel: string;
}) {
  const { redirecting, startCheckout } = useStartCheckout(subAccountId);

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-6">
      <div className="w-full max-w-md rounded-2xl border bg-card p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
          <Lock className="h-5 w-5 text-primary" />
        </div>
        <h1 className="text-xl font-semibold">
          {mode === "pending"
            ? "Activate your subscription"
            : "Subscription paused"}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {mode === "pending" ? (
            <>
              This workspace is ready to go
              {planName ? (
                <>
                  {" "}
                  on the <strong>{planName}</strong> plan
                  {priceLabel !== "—" ? ` (${priceLabel})` : ""}
                </>
              ) : null}
              . Complete checkout to unlock it.
            </>
          ) : (
            <>
              Payment for this workspace couldn&apos;t be collected, so access
              is paused. All your data is safe — completing payment restores
              everything instantly.
            </>
          )}
        </p>
        {isAdmin ? (
          <Button className="mt-6" onClick={startCheckout} disabled={redirecting}>
            {redirecting ? (
              <>
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                Opening checkout…
              </>
            ) : (
              <>
                <CreditCard className="mr-1.5 h-4 w-4" />
                {mode === "pending" ? "Complete checkout" : "Pay & restore access"}
              </>
            )}
          </Button>
        ) : (
          <p className="mt-6 text-sm text-muted-foreground">
            Ask your workspace admin to complete the payment.
          </p>
        )}
        <p className="mt-4 text-xs text-muted-foreground">
          Payments are processed securely by Stripe.
        </p>
      </div>
    </div>
  );
}
