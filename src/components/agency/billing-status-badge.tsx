"use client";

import { cn } from "@/lib/utils";
import {
  effectiveBillingState,
  type EffectiveBillingState,
} from "@/lib/billing/status";
import type { SubAccountBilling } from "@/types/billing";

/**
 * Billing state pill (Client Billing v1). Derives the effective state
 * (grace vs lapsed etc.) from the billing field so every surface — the
 * Client billing table, the Manage dialog — shows the same word.
 */

const STYLES: Record<EffectiveBillingState, { label: string; className: string }> =
  {
    comped: {
      label: "Comped",
      className: "bg-muted text-muted-foreground",
    },
    pending: {
      label: "Awaiting payment",
      className:
        "bg-blue-500/10 text-blue-700 dark:text-blue-400",
    },
    active: {
      label: "Active",
      className:
        "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    },
    grace: {
      label: "Past due",
      className:
        "bg-amber-500/10 text-amber-700 dark:text-amber-400",
    },
    lapsed: {
      label: "Lapsed",
      className: "bg-red-500/10 text-red-700 dark:text-red-400",
    },
  };

export function BillingStatusBadge({
  billing,
  className,
}: {
  billing: SubAccountBilling | null | undefined;
  className?: string;
}) {
  const state = effectiveBillingState(billing);
  const style = STYLES[state];
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[11px] font-medium",
        style.className,
        className,
      )}
    >
      {style.label}
    </span>
  );
}
