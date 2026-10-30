"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  INVOICE_FILTERS,
  isOverdue,
  matchesFilter,
  paidThisMonth,
  sumByCurrency,
  type InvoiceFilter,
} from "@/lib/billing/invoice-filters";
import { InvoiceRow } from "@/components/agency/agency-invoice-row";
import type { BillingChargeResponse } from "@/types/billing";
import type { SubAccountDoc } from "@/types";

/** Agency > Client billing > Invoices: one-time and usage charges across every client. */

export function AgencyInvoicesPanel({ subs }: { subs: SubAccountDoc[] }) {
  const [charges, setCharges] = useState<BillingChargeResponse[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<InvoiceFilter>("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  // Refreshed with each load, so the past-due cut-off tracks the data on screen.
  const [now, setNow] = useState(() => new Date());

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const r = await fetch("/api/agency/billing/charges");
      if (!r.ok) throw new Error(String(r.status));
      const d = (await r.json()) as { charges?: BillingChargeResponse[]; truncated?: boolean };
      setCharges(d.charges ?? []);
      setTruncated(d.truncated === true);
      setNow(new Date());
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const names = useMemo(() => new Map(subs.map((s) => [s.id, s.name])), [subs]);

  const totals = useMemo(() => {
    const list = charges ?? [];
    return {
      outstanding: sumByCurrency(list.filter((c) => c.status === "pending")),
      overdue: sumByCurrency(list.filter((c) => isOverdue(c, now))),
      collected: sumByCurrency(paidThisMonth(list, now)),
    };
  }, [charges, now]);

  const counts = useMemo(() => {
    const out = {} as Record<InvoiceFilter, number>;
    for (const f of INVOICE_FILTERS)
      out[f.id] = (charges ?? []).filter((c) => matchesFilter(c, f.id, now)).length;
    return out;
  }, [charges, now]);

  const visible = (charges ?? []).filter((c) => matchesFilter(c, filter, now));

  async function copyLink(c: BillingChargeResponse) {
    if (
      c.kind === "usage" &&
      !window.confirm(
        "Copy a new payment link? The link in the invoice email stops working; reminders use the new one.",
      )
    ) {
      return;
    }
    setBusyId(c.id);
    try {
      const res = await fetch(
        `/api/agency/sub-accounts/${c.subAccountId}/billing/charges/${c.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "sendLink" }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        checkoutUrl?: string;
      };
      if (!res.ok || !data.checkoutUrl)
        throw new Error(data.error ?? "Failed to mint a link.");
      await navigator.clipboard
        .writeText(data.checkoutUrl)
        .catch(() => undefined);
      toast.success("Fresh payment link copied. Older links no longer work.");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to mint a link.",
      );
    } finally {
      setBusyId(null);
    }
  }

  async function cancel(c: BillingChargeResponse) {
    const usage = c.kind === "usage";
    const question = usage
      ? "Waive this usage charge? The client won't be asked to pay it, and any overdue banner or paywall it caused lifts."
      : "Cancel this charge? Its payment link goes dead immediately.";
    if (!window.confirm(question)) return;
    setBusyId(c.id);
    try {
      const res = await fetch(
        `/api/agency/sub-accounts/${c.subAccountId}/billing/charges/${c.id}`,
        {
          method: "DELETE",
        },
      );
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to cancel.");
      toast.success(usage ? "Usage charge waived." : "Charge canceled.");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to cancel.");
    } finally {
      setBusyId(null);
    }
  }

  if (failed) {
    return (
      <div className="bg-card text-muted-foreground rounded-2xl border p-8 text-center text-sm">
        Couldn&apos;t load invoices.{" "}
        <button
          type="button"
          className="text-primary hover:underline"
          onClick={() => void load()}
        >
          Try again
        </button>
      </div>
    );
  }
  if (!charges)
    return <div className="bg-muted/50 h-40 animate-pulse rounded-2xl" />;

  return (
    <div className="space-y-4">
      {truncated && (
        <div
          role="status"
          className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-400"
        >
          Showing {charges.length.toLocaleString()} invoices. There are more than this, so the
          totals below may be incomplete.
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Outstanding" value={totals.outstanding} />
        <Stat
          label="Past due"
          value={totals.overdue}
          tone={counts.overdue > 0 ? "bad" : undefined}
        />
        <Stat label="Collected this month" value={totals.collected} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5">
          {INVOICE_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={
                "rounded-full border px-3 py-1 text-xs transition-colors " +
                (filter === f.id
                  ? "border-foreground/30 bg-muted text-foreground font-medium"
                  : "text-muted-foreground hover:text-foreground")
              }
            >
              {f.label} <span className="tabular-nums">{counts[f.id]}</span>
            </button>
          ))}
        </div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={() => void load()}
        >
          <RefreshCw className="mr-1 h-3 w-3" />
          Refresh
        </Button>
      </div>

      <div className="bg-card overflow-x-auto rounded-2xl border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-muted-foreground text-xs tracking-wide uppercase">
            <tr>
              <th className="px-4 py-2.5 text-left font-medium">Issued</th>
              <th className="px-4 py-2.5 text-left font-medium">Client</th>
              <th className="px-4 py-2.5 text-left font-medium">What for</th>
              <th className="px-4 py-2.5 text-right font-medium">Amount</th>
              <th className="px-4 py-2.5 text-left font-medium">Due</th>
              <th className="px-4 py-2.5 text-left font-medium">Status</th>
              <th className="px-4 py-2.5"></th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="text-muted-foreground px-4 py-12 text-center"
                >
                  {charges.length === 0
                    ? "No invoices yet. One-time charges and monthly usage charges appear here once issued."
                    : "Nothing matches this filter."}
                </td>
              </tr>
            ) : (
              visible.map((c) => (
                <InvoiceRow
                  key={c.id}
                  c={c}
                  clientName={names.get(c.subAccountId) ?? "Deleted client"}
                  now={now}
                  busy={busyId === c.id}
                  anyBusy={busyId !== null}
                  onCopyLink={(row) => void copyLink(row)}
                  onCancel={(row) => void cancel(row)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
      <p className="text-muted-foreground text-xs">
        One-time charges and monthly usage charges. Plan subscription payments,
        refunds and payouts are in your payment provider&apos;s dashboard.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "bad";
}) {
  return (
    <div className="bg-card rounded-2xl border p-4">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p
        className={
          "mt-1 text-lg font-semibold tabular-nums " +
          (tone === "bad" ? "text-rose-600 dark:text-rose-400" : "")
        }
      >
        {value}
      </p>
    </div>
  );
}
