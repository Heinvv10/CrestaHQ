"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, query, where } from "firebase/firestore";
import { toast } from "sonner";
import { Archive, CreditCard, Pencil, Plus } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { getFirebaseDb } from "@/lib/firebase/client";
import { Button } from "@/components/ui/button";
import { PlanEditorDialog } from "@/components/agency/plan-editor-dialog";
import { BillingStatusBadge } from "@/components/agency/billing-status-badge";
import { UsageQuotaBadge } from "@/components/agency/usage-quota-badge";
import { SubAccountManageDialog } from "@/components/agency/sub-account-manage-dialog";
import { ResellingTable } from "@/components/agency/reselling-table";
import { AttentionList } from "@/components/billing/attention-list";
import {
  effectiveBillingState,
  formatBillingPrice,
  formatBillingPriceWithInterval,
  isMrrEligible,
  monthlyEquivalentCents,
} from "@/lib/billing/status";
import {
  PLAN_GATE_KEYS,
  type BillingPlanResponse,
} from "@/types/billing";
import type { SubAccountDoc } from "@/types";

/**
 * Agency → Client billing (Client Billing v1). Two halves:
 *   1. Plans — the agency's priced feature bundles (create/edit/archive).
 *   2. Clients — every sub-account with its plan + live billing state and
 *      the MRR roll-up. Manage opens the same dialog as the Sub-accounts
 *      page (Billing tab included).
 *
 * Owner-only: the API routes reject non-owners; the page renders a notice.
 */

export default function AgencyBillingPage() {
  const { agencyId, agencyRole, loading: authLoading } = useAuth();
  const isOwner = agencyRole === "owner";

  const [plans, setPlans] = useState<BillingPlanResponse[] | null>(null);
  const [stripeConfigured, setStripeConfigured] = useState(true);
  const [subs, setSubs] = useState<SubAccountDoc[]>([]);
  const [subsLoading, setSubsLoading] = useState(true);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingPlan, setEditingPlan] = useState<BillingPlanResponse | null>(
    null,
  );
  const [managingId, setManagingId] = useState<string | null>(null);
  const managing = subs.find((s) => s.id === managingId) ?? null;

  const refreshPlans = useCallback(() => {
    void fetch("/api/agency/plans")
      .then((r) => r.json())
      .then(
        (d: { plans?: BillingPlanResponse[]; stripeConfigured?: boolean }) => {
          setPlans(d.plans ?? []);
          setStripeConfigured(d.stripeConfigured !== false);
        },
      )
      .catch(() => setPlans([]));
  }, []);

  useEffect(() => {
    if (isOwner) refreshPlans();
  }, [isOwner, refreshPlans]);

  useEffect(() => {
    if (!agencyId || !isOwner) {
      setSubs([]);
      setSubsLoading(false);
      return;
    }
    const q = query(
      collection(getFirebaseDb(), "subAccounts"),
      where("agencyId", "==", agencyId),
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list = snap.docs.map((d) => d.data() as SubAccountDoc);
        list.sort(
          (a, b) =>
            (a.accountNumber ?? Number.MAX_SAFE_INTEGER) -
            (b.accountNumber ?? Number.MAX_SAFE_INTEGER),
        );
        setSubs(list);
        setSubsLoading(false);
      },
      (err) => {
        console.error("[agency/billing] listen failed", err);
        setSubsLoading(false);
      },
    );
    return () => unsub();
  }, [agencyId, isOwner]);

  // MRR roll-up per currency (a deployment can mix e.g. usd + aud plans).
  // Annual subscriptions are normalized to their monthly-equivalent (/12) so
  // the roll-up stays a true MONTHLY recurring figure.
  const mrr = useMemo(() => {
    const byCurrency = new Map<string, number>();
    for (const s of subs) {
      const state = effectiveBillingState(s.billing);
      if (!isMrrEligible(state)) continue;
      const currency = s.billing?.currency;
      if (typeof s.billing?.priceCents !== "number" || !currency) continue;
      const cents = monthlyEquivalentCents(
        s.billing.priceCents,
        s.billing.billingInterval,
      );
      byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + cents);
    }
    return [...byCurrency.entries()]
      .map(([currency, cents]) => formatBillingPrice(cents, currency))
      .join(" + ");
  }, [subs]);

  async function handleArchive(plan: BillingPlanResponse) {
    if (
      !window.confirm(
        `Archive "${plan.name}"? Clients already on it keep their subscription; it just can't be assigned anymore.`,
      )
    ) {
      return;
    }
    try {
      const res = await fetch(`/api/agency/plans/${plan.id}`, {
        method: "DELETE",
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to archive.");
      toast.success(`Archived ${plan.name}.`);
      refreshPlans();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to archive.");
    }
  }

  if (authLoading) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-6">
        <div className="h-8 w-48 animate-pulse rounded bg-muted" />
        <div className="h-32 animate-pulse rounded-2xl bg-muted/50" />
      </div>
    );
  }

  if (!isOwner) {
    return (
      <div className="mx-auto w-full max-w-5xl">
        <div className="rounded-2xl border bg-card p-12 text-center text-muted-foreground">
          <CreditCard className="mx-auto mb-2 h-6 w-6" />
          Client billing is managed by the agency owner.
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            Client billing
            {/* Same Beta pill as the beta feature gates in the Manage dialog. */}
            <span className="rounded-full bg-fuchsia-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-fuchsia-600 dark:text-fuchsia-400">
              Beta
            </span>
          </h1>
          <p className="text-sm text-muted-foreground">
            Package features into monthly plans and charge your clients through
            your own Stripe account.
          </p>
        </div>
        <Button
          onClick={() => {
            setEditingPlan(null);
            setEditorOpen(true);
          }}
          disabled={!stripeConfigured}
        >
          <Plus className="mr-1 h-4 w-4" />
          New plan
        </Button>
      </div>

      {!stripeConfigured && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-400">
          Stripe isn&apos;t configured on this deployment. Set{" "}
          <code>STRIPE_SECRET_KEY</code> (and the webhook secret) to create
          plans and charge clients — payments land in <em>your</em> Stripe
          account.
        </div>
      )}

      <AttentionList
        endpoint="/api/agency/billing-attention"
        title="Payments needing attention"
        nameFor={(id) => subs.find((s) => s.id === id)?.name ?? id}
      />

      {/* Plans */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Plans
        </h2>
        {plans === null ? (
          <div className="h-28 animate-pulse rounded-2xl bg-muted/50" />
        ) : plans.length === 0 ? (
          <div className="rounded-2xl border border-dashed bg-card p-8 text-center text-sm text-muted-foreground">
            No plans yet. Create your first plan — e.g.{" "}
            <span className="font-medium text-foreground">Starter $97/mo</span>{" "}
            or{" "}
            <span className="font-medium text-foreground">Pro $297/mo</span> —
            then assign it to a client from the table below.
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {plans.map((plan) => {
              const gateCount = PLAN_GATE_KEYS.filter(
                (k) => plan.gates[k],
              ).length;
              const clientCount = subs.filter(
                (s) =>
                  s.billing?.planId === plan.id &&
                  effectiveBillingState(s.billing) !== "comped",
              ).length;
              return (
                <div
                  key={plan.id}
                  className={
                    plan.status === "archived"
                      ? "rounded-2xl border bg-card p-4 opacity-60"
                      : "rounded-2xl border bg-card p-4"
                  }
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-semibold">{plan.name}</p>
                      <p className="mt-0.5 text-xl font-bold tracking-tight">
                        {formatBillingPrice(
                          plan.priceMonthlyCents,
                          plan.currency,
                        )}
                        <span className="text-xs font-normal text-muted-foreground">
                          /mo
                        </span>
                      </p>
                      {plan.priceAnnualCents != null && (
                        <p className="text-xs text-muted-foreground">
                          or{" "}
                          {formatBillingPrice(
                            plan.priceAnnualCents,
                            plan.currency,
                          )}
                          /yr
                        </p>
                      )}
                    </div>
                    {plan.status === "archived" && (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                        Archived
                      </span>
                    )}
                  </div>
                  {plan.description && (
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                      {plan.description}
                    </p>
                  )}
                  <p className="mt-2 text-xs text-muted-foreground">
                    {gateCount} feature{gateCount === 1 ? "" : "s"} ·{" "}
                    {clientCount} client{clientCount === 1 ? "" : "s"}
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 px-2.5 text-xs"
                      onClick={() => {
                        setEditingPlan(plan);
                        setEditorOpen(true);
                      }}
                    >
                      <Pencil className="mr-1 h-3 w-3" />
                      Edit
                    </Button>
                    {plan.status === "active" && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2.5 text-xs text-muted-foreground"
                        onClick={() => handleArchive(plan)}
                      >
                        <Archive className="mr-1 h-3 w-3" />
                        Archive
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Clients */}
      <section className="space-y-3">
        <div className="flex items-end justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            Clients
          </h2>
          {mrr && (
            <p className="text-sm text-muted-foreground">
              MRR: <span className="font-semibold text-foreground">{mrr}</span>
            </p>
          )}
        </div>
        <div className="overflow-hidden rounded-2xl border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="w-20 px-4 py-2.5 text-left font-medium">#</th>
                <th className="px-4 py-2.5 text-left font-medium">Client</th>
                <th className="px-4 py-2.5 text-left font-medium">Plan</th>
                <th className="px-4 py-2.5 text-left font-medium">Billing</th>
                <th className="px-4 py-2.5 text-right font-medium">Monthly</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {subsLoading ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-8 text-center text-muted-foreground"
                  >
                    Loading…
                  </td>
                </tr>
              ) : subs.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-4 py-12 text-center text-muted-foreground"
                  >
                    No sub-accounts yet.{" "}
                    <Link
                      href="/agency/sub-accounts/new"
                      className="text-primary hover:underline"
                    >
                      Create one
                    </Link>
                    .
                  </td>
                </tr>
              ) : (
                subs.map((s) => {
                  const billing = s.billing ?? null;
                  const billed =
                    billing && billing.status !== "comped";
                  return (
                    <tr key={s.id} className="border-t">
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                        {s.accountNumber !== undefined
                          ? `#${s.accountNumber}`
                          : "—"}
                      </td>
                      <td className="px-4 py-3 font-medium">{s.name}</td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {billed ? (billing.planName ?? "—") : "—"}
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex flex-wrap items-center gap-1.5">
                          <BillingStatusBadge billing={billing} />
                          <UsageQuotaBadge subAccountId={s.id} />
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">
                        {billed
                          ? formatBillingPriceWithInterval(
                              billing.priceCents,
                              billing.currency,
                              billing.billingInterval,
                            )
                          : "—"}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          type="button"
                          size="sm"
                          className="h-7 rounded-full px-3 text-xs"
                          onClick={() => setManagingId(s.id)}
                        >
                          Manage
                        </Button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground">
          &quot;Comped&quot; clients aren&apos;t billed through the platform —
          every workspace starts comped until you assign a plan. Payments,
          invoices, and payout timing live in your{" "}
          <a
            href="https://dashboard.stripe.com"
            target="_blank"
            rel="noreferrer"
            className="text-primary hover:underline"
          >
            Stripe dashboard
          </a>
          .
        </p>
      </section>

      {plans !== null && (
        <ResellingTable
          plans={plans}
          subs={subs}
          subsLoading={subsLoading}
          stripeConfigured={stripeConfigured}
        />
      )}

      <PlanEditorDialog
        plan={editingPlan}
        open={editorOpen}
        onOpenChange={setEditorOpen}
        onSaved={refreshPlans}
      />

      <SubAccountManageDialog
        subAccount={managing}
        open={!!managingId}
        onOpenChange={(open) => {
          if (!open) setManagingId(null);
        }}
      />
    </div>
  );
}
