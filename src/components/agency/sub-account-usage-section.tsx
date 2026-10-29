"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Gauge, Loader2, Receipt } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatBillingPrice } from "@/lib/billing/status";
import type { UsageQuotas } from "@/types/usage";

/**
 * Usage Metering v1 — agency-eyes-only usage readout inside the Manage
 * dialog. Current month per unit (used / quota / % bar; "—" = unlimited)
 * plus a 3-month mini-history. Data comes from the owner-only usage GET
 * (the ledger is server-only in rules). The usage-rebilling switch sits
 * above it; the overage preview shows only while the client is rebilled.
 */

interface MonthRow {
  month: string;
  emailsSent: number;
  smsSegments: number;
  whatsappMessages: number;
  aiTokens: number;
  voiceSeconds: number;
}

interface UsageResponse {
  usage: MonthRow[];
  quotas: UsageQuotas | null;
  quotaSource: "workspace" | "plan" | "none";
  /** v1.5 — current month's usage beyond quotas, valued at the sell rates. */
  overage?: {
    perUnit: Partial<
      Record<keyof Omit<MonthRow, "month">, { overUnits: number; cents: number }>
    >;
    totalCents: number;
  };
  /** The plan's currency, else the payment provider's (the route resolves it). */
  currency: string;
  /** `active` = agency switch AND client switch; the overage is zero otherwise. */
  rebilling: { active: boolean; agency: boolean; client: boolean };
}

const UNITS: {
  field: keyof Omit<MonthRow, "month">;
  quotaKey: keyof UsageQuotas;
  label: string;
  /** Render ledger value for display (voice seconds → minutes). */
  display: (n: number) => string;
  /** Convert quota (config units) to ledger units for the % math. */
  quotaToLedger: (q: number) => number;
}[] = [
  {
    field: "emailsSent",
    quotaKey: "emailsPerMonth",
    label: "Emails",
    display: (n) => n.toLocaleString(),
    quotaToLedger: (q) => q,
  },
  {
    field: "smsSegments",
    quotaKey: "smsSegmentsPerMonth",
    label: "SMS segments",
    display: (n) => n.toLocaleString(),
    quotaToLedger: (q) => q,
  },
  {
    field: "whatsappMessages",
    quotaKey: "whatsappPerMonth",
    label: "WhatsApp",
    display: (n) => n.toLocaleString(),
    quotaToLedger: (q) => q,
  },
  {
    field: "aiTokens",
    quotaKey: "aiTokensPerMonth",
    label: "AI tokens",
    display: (n) => n.toLocaleString(),
    quotaToLedger: (q) => q,
  },
  {
    field: "voiceSeconds",
    quotaKey: "voiceMinutesPerMonth",
    label: "Voice minutes",
    display: (n) => String(Math.round(n / 60)),
    quotaToLedger: (q) => q * 60,
  },
];

export function SubAccountUsageSection({
  subAccountId,
}: {
  subAccountId: string;
}) {
  const [data, setData] = useState<UsageResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setFailed(false);
    fetch(`/api/agency/sub-accounts/${subAccountId}/usage`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: UsageResponse) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [subAccountId, reloadKey]);

  const current = data?.usage[0];
  const history = data?.usage ?? [];

  return (
    <div className="space-y-4">
      {data && (
        <RebillingCard
          subAccountId={subAccountId}
          rebilling={data.rebilling}
          onSaved={() => setReloadKey((k) => k + 1)}
        />
      )}
      <section className="rounded-xl border p-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Gauge className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Usage</h3>
          </div>
          {data && (
            <span className="text-[11px] text-muted-foreground">
              {data.quotaSource === "workspace"
                ? "Limits: workspace override"
                : data.quotaSource === "plan"
                  ? "Limits: from plan"
                  : "No limits set"}
            </span>
          )}
        </div>

        {failed ? (
          <p className="text-xs text-muted-foreground">
            Couldn&apos;t load usage right now.
          </p>
        ) : !data || !current ? (
          <div className="h-24 animate-pulse rounded-lg bg-muted/40" />
        ) : (
          <div className="space-y-2.5">
            {UNITS.map((u) => {
              const used = current[u.field];
              const quotaRaw = data.quotas?.[u.quotaKey];
              const limit =
                typeof quotaRaw === "number" && quotaRaw > 0
                  ? u.quotaToLedger(quotaRaw)
                  : null;
              const pct = limit ? Math.min(100, (used / limit) * 100) : null;
              return (
                <div key={u.field}>
                  <div className="flex items-baseline justify-between text-xs">
                    <span className="text-muted-foreground">{u.label}</span>
                    <span
                      className={
                        pct !== null && pct >= 100
                          ? "font-medium text-rose-600 dark:text-rose-400"
                          : pct !== null && pct >= 80
                            ? "font-medium text-amber-600 dark:text-amber-400"
                            : "font-medium"
                      }
                    >
                      {u.display(used)}
                      {limit !== null
                        ? ` / ${u.display(limit)}`
                        : " · unlimited"}
                    </span>
                  </div>
                  {pct !== null && (
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className={`h-full rounded-full ${
                          pct >= 100
                            ? "bg-rose-500"
                            : pct >= 80
                              ? "bg-amber-500"
                              : "bg-emerald-500"
                        }`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  )}
                </div>
              );
            })}

            {data.rebilling.active && data.overage && data.overage.totalCents > 0 && (
              <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
                  Overage accruing this month:{" "}
                  {formatBillingPrice(data.overage.totalCents, data.currency)}
                </p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  Usage beyond the included allowance at your configured rates.
                  A preview only: no charge is created from it. Invoice it via a
                  one-time charge in the Billing section above.
                </p>
              </div>
            )}

            {history.length > 1 && (
              <div className="mt-3 border-t pt-2">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Recent months
                </p>
                <div className="overflow-x-auto">
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="text-left text-muted-foreground">
                        <th className="py-0.5 pr-2 font-normal">Month</th>
                        {UNITS.map((u) => (
                          <th key={u.field} className="py-0.5 pr-2 font-normal">
                            {u.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {history.map((m) => (
                        <tr key={m.month}>
                          <td className="py-0.5 pr-2 text-muted-foreground">
                            {m.month}
                          </td>
                          {UNITS.map((u) => (
                            <td key={u.field} className="py-0.5 pr-2">
                              {u.display(m[u.field])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function RebillingCard({
  subAccountId,
  rebilling,
  onSaved,
}: {
  subAccountId: string;
  rebilling: UsageResponse["rebilling"];
  onSaved: () => void;
}) {
  const [confirming, setConfirming] = useState<null | boolean>(null);
  const [busy, setBusy] = useState(false);

  async function save(next: boolean) {
    setBusy(true);
    try {
      const res = await fetch(`/api/agency/sub-accounts/${subAccountId}/feature-gates`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ usageRebillingEnabled: next }),
      });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(d.error ?? "Couldn't save.");
      toast.success(next ? "This client is now rebilled." : "Rebilling stopped for this client.");
      setConfirming(null);
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Receipt className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Usage rebilling</h3>
            <span
              className={
                "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide " +
                (rebilling.active
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "bg-muted text-muted-foreground")
              }
            >
              {rebilling.active ? "Rebilled" : "Metering only"}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {rebilling.active
              ? "Usage past the included allowance is valued at this client's rates below. No charge is created from it automatically."
              : rebilling.agency
                ? "Usage is counted but not valued. Turn this on to see what this client owes for usage past their allowance."
                : "Usage rebilling is off for the agency."}
            {!rebilling.agency && (
              <>
                {" "}
                <Link href="/agency/billing" className="underline">
                  Turn it on in Client billing
                </Link>
                .
              </>
            )}
          </p>
        </div>
        {confirming === null && (
          <Button
            type="button"
            size="sm"
            variant={rebilling.client ? "outline" : "default"}
            disabled={busy || (!rebilling.client && !rebilling.agency)}
            onClick={() => setConfirming(!rebilling.client)}
          >
            {rebilling.client ? "Stop rebilling" : "Rebill this client"}
          </Button>
        )}
      </div>

      {confirming !== null && (
        <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
          <p className="text-amber-800 dark:text-amber-300">
            {confirming
              ? "This client's usage past the allowance will be valued at their rates from now on."
              : "This client's usage will no longer be valued. Charges already sent stay payable."}
          </p>
          <div className="mt-2 flex gap-2">
            <Button
              type="button"
              size="sm"
              className="h-7 text-xs"
              disabled={busy}
              onClick={() => void save(confirming)}
            >
              {busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
              {confirming ? "Yes, rebill" : "Yes, stop"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              disabled={busy}
              onClick={() => setConfirming(null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
