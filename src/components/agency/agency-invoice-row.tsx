"use client";

import { Copy, Loader2, X } from "lucide-react";
import { formatBillingPrice } from "@/lib/billing/status";
import { isOverdue } from "@/lib/billing/invoice-filters";
import type { BillingChargeResponse } from "@/types/billing";

/** One row of the agency Invoices table (agency-invoices-panel.tsx). Dates are local. */

function shortDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export function InvoiceRow({
  c,
  clientName,
  now,
  busy,
  anyBusy,
  onCopyLink,
  onCancel,
}: {
  c: BillingChargeResponse;
  clientName: string;
  now: Date;
  /** This row's action is running. */
  busy: boolean;
  /** Some row's action is running: every action waits. */
  anyBusy: boolean;
  onCopyLink: (c: BillingChargeResponse) => void;
  onCancel: (c: BillingChargeResponse) => void;
}) {
  const usage = c.kind === "usage";
  const overdue = isOverdue(c, now);
  const label =
    c.status === "paid"
      ? "Paid"
      : c.status === "canceled"
        ? usage
          ? "Waived"
          : "Canceled"
        : overdue
          ? "Past due"
          : "Pending";
  return (
        <tr className="border-t">
          <td className="text-muted-foreground px-4 py-3 whitespace-nowrap">
            {shortDate(c.createdAt)}
          </td>
          <td className="px-4 py-3 font-medium">
            {clientName}
          </td>
          <td className="px-4 py-3">
            <span className="flex items-center gap-1.5">
              {usage && (
                <span className="shrink-0 rounded-full bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-semibold tracking-wide text-sky-600 uppercase dark:text-sky-400">
                  Usage
                </span>
              )}
              <span className="min-w-0 truncate">
                {c.description}
              </span>
            </span>
          </td>
          <td className="px-4 py-3 text-right whitespace-nowrap tabular-nums">
            {formatBillingPrice(c.amountCents, c.currency)}{" "}
            <span className="text-muted-foreground text-xs">
              {c.currency.toUpperCase()}
            </span>
          </td>
          <td className="text-muted-foreground px-4 py-3 whitespace-nowrap">
            {shortDate(c.dueAt)}
          </td>
          <td className="px-4 py-3 whitespace-nowrap">
            <span
              className={
                "rounded-full px-2 py-0.5 text-[11px] font-medium " +
                (c.status === "paid"
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : c.status === "canceled"
                    ? "bg-muted text-muted-foreground"
                    : overdue
                      ? "bg-rose-500/10 text-rose-600 dark:text-rose-400"
                      : "bg-amber-500/10 text-amber-600 dark:text-amber-400")
              }
            >
              {label}
            </span>
            {c.status === "paid" && c.paidAt && (
              <span className="text-muted-foreground ml-1.5 text-xs">
                {shortDate(c.paidAt)}
              </span>
            )}
          </td>
          <td className="px-4 py-3 text-right whitespace-nowrap">
            {c.status === "pending" && (
              <span className="inline-flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onCopyLink(c)}
                  disabled={anyBusy}
                  title="Copy a fresh payment link"
                  aria-label="Copy a fresh payment link"
                  className="text-muted-foreground hover:text-foreground rounded p-1 transition-colors disabled:opacity-50"
                >
                  {busy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => onCancel(c)}
                  disabled={anyBusy}
                  title={
                    usage
                      ? "Waive this usage charge"
                      : "Cancel this charge"
                  }
                  aria-label={
                    usage
                      ? "Waive this usage charge"
                      : "Cancel this charge"
                  }
                  className="text-muted-foreground hover:text-destructive rounded p-1 transition-colors disabled:opacity-50"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            )}
          </td>
        </tr>
  );
}
