"use client";

import { useEffect, useState } from "react";
import { Gauge } from "lucide-react";
import { formatBillingPrice } from "@/lib/billing/status";
import type { UsageQuotas } from "@/types/usage";

/**
 * Usage Metering v1 — agency-eyes-only usage readout inside the Manage
 * dialog. Current month per unit (used / quota / % bar; "—" = unlimited)
 * plus a 3-month mini-history. Data comes from the owner-only usage GET
 * (the ledger is server-only in rules).
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
  }, [subAccountId]);

  const current = data?.usage[0];
  const history = data?.usage ?? [];

  return (
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

          {data.overage && data.overage.totalCents > 0 && (
            <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
              <p className="text-xs font-medium text-amber-700 dark:text-amber-400">
                Overage accruing this month:{" "}
                {formatBillingPrice(data.overage.totalCents, data.currency)}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Usage beyond the included allowance at your configured rates.
                Invoice it via a one-time charge in the Billing section above —
                automatic monthly billing is a later stage.
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
  );
}
