"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Repeat } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { computeQuoteTotals } from "@/lib/quotes/calc";
import { timestampSeconds } from "@/lib/recurring/schedule-form";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";
import type {
  RecurringInvoiceDoc,
  RecurringInvoiceStatus,
} from "@/types/recurring-invoices";

/**
 * The operator's view of every standing billing instruction in this
 * workspace: what it charges, when it next fires, whether it is behind on
 * payment, and what the last run complained about.
 *
 * Reads through the admin API rather than a Firestore subscription — the
 * schedules collection is server-write-only under default-deny rules, so
 * there is no client read path to subscribe to.
 */

interface RecurringInvoiceListProps {
  subAccountId: string;
  contactNames: Record<string, string>;
  /** Link builder for the sub-account-scoped route prefix. */
  saPath: (path: string) => string;
}

const STATUS_STYLES: Record<RecurringInvoiceStatus, string> = {
  active: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  paused: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  completed: "bg-muted text-muted-foreground",
  cancelled: "bg-muted text-muted-foreground",
};

export function RecurringInvoiceList({
  subAccountId,
  contactNames,
  saPath,
}: RecurringInvoiceListProps) {
  const [schedules, setSchedules] = useState<RecurringInvoiceDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/recurring-invoices`,
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Failed to load (HTTP ${res.status})`);
      }
      const data = (await res.json()) as { schedules: RecurringInvoiceDoc[] };
      setSchedules(data.schedules);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load schedules");
    } finally {
      setLoading(false);
    }
  }, [subAccountId]);

  useEffect(() => {
    void load();
  }, [load]);

  const setStatus = async (id: string, status: RecurringInvoiceStatus) => {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/recurring-invoices/${id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Update failed (HTTP ${res.status})`);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <Card className="p-6 text-sm text-muted-foreground">
        Loading schedules…
      </Card>
    );
  }

  if (schedules.length === 0) {
    return (
      <Card className="p-8 text-center">
        <Repeat className="mx-auto h-8 w-8 text-muted-foreground" />
        <p className="mt-3 text-sm font-medium">No recurring invoices yet</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Put a retainer or subscription on a cadence and the invoice goes out
          on its own each cycle.
        </p>
        {error && <ErrorLine message={error} />}
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {error && <ErrorLine message={error} />}
      {schedules.map((schedule) => {
        const totals = computeQuoteTotals({
          lineItems: schedule.lineItems,
          globalDiscount: schedule.globalDiscount,
          globalTaxPercent: schedule.globalTaxPercent,
        });
        const live = schedule.status === "active" || schedule.status === "paused";
        return (
          <Card key={schedule.id} className="p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Link
                    href={saPath(`/quotes/recurring/${schedule.id}`)}
                    className="truncate font-medium hover:underline"
                  >
                    {schedule.name}
                  </Link>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[11px] font-medium capitalize",
                      STATUS_STYLES[schedule.status],
                    )}
                  >
                    {schedule.status}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {contactNames[schedule.contactId] ?? "Unknown contact"} ·{" "}
                  {formatCurrency(totals.total, schedule.currency)} every{" "}
                  {cadenceLabel(schedule)}
                  {schedule.reviewFirst && " · review first"}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {schedule.status === "active"
                    ? `Next invoice ${formatDay(schedule.nextRunAt, schedule.timezone)}`
                    : `${schedule.cyclesGenerated} invoice${schedule.cyclesGenerated === 1 ? "" : "s"} raised`}
                </p>
                {schedule.outstandingInvoices > 0 && (
                  <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-400">
                    {schedule.outstandingInvoices} unpaid invoice
                    {schedule.outstandingInvoices === 1 ? "" : "s"}
                  </p>
                )}
                {schedule.lastError && (
                  <p className="mt-1 flex items-start gap-1.5 text-xs text-destructive">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {schedule.lastError}
                  </p>
                )}
              </div>

              {live && (
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busyId === schedule.id}
                    onClick={() =>
                      setStatus(
                        schedule.id,
                        schedule.status === "active" ? "paused" : "active",
                      )
                    }
                  >
                    {schedule.status === "active" ? "Pause" : "Resume"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busyId === schedule.id}
                    onClick={() => {
                      // Terminal by design: restarting billing after a
                      // cancellation is a new agreement, so it is a new
                      // schedule. Worth one confirmation.
                      if (
                        window.confirm(
                          `Stop billing "${schedule.name}" for good? Invoices already raised are unaffected.`,
                        )
                      ) {
                        void setStatus(schedule.id, "cancelled");
                      }
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      {message}
    </p>
  );
}

function cadenceLabel(schedule: RecurringInvoiceDoc): string {
  const { unit, interval } = schedule.cadence;
  return interval === 1 ? unit : `${interval} ${unit}s`;
}

/**
 * A schedule's date rendered in the schedule's own timezone — the day it bills
 * on is the day the business is in, so showing the reader's day would
 * sometimes be a day out.
 */
function formatDay(value: unknown, timezone: string): string {
  const seconds = timestampSeconds(value);
  if (seconds === null) return "—";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(seconds * 1000));
}
