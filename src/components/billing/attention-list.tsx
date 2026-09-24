"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatBillingPrice } from "@/lib/billing/status";
import type { AttentionItem } from "@/types/billing";

/**
 * Flagged payments awaiting a person, with "Mark resolved". Used by Client
 * billing (plan-payment flags, `/api/agency/billing-attention`) and Reports →
 * Payments (order flags, `/api/sub-accounts/[id]/order-attention`). Both
 * routes take `{ flagId, orderId }` on POST (orderId is ignored by the agency
 * route). Renders nothing when there is nothing to show.
 */
export function AttentionList({
  endpoint,
  title,
  nameFor,
}: {
  endpoint: string;
  title: string;
  /** Sub-account display name; omit on a single-sub-account page. */
  nameFor?: (subAccountId: string) => string;
}) {
  const [items, setItems] = useState<AttentionItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    void fetch(endpoint)
      .then(async (r) => {
        const d = (await r.json().catch(() => ({}))) as { items?: AttentionItem[]; error?: string };
        if (!r.ok) throw new Error(d.error ?? "Could not load flagged payments.");
        setItems(d.items ?? []);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Could not load flagged payments."));
  }, [endpoint]);

  useEffect(load, [load]);

  async function resolve(item: AttentionItem) {
    setBusy(item.flagId);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flagId: item.flagId, orderId: item.orderId }),
      });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(d.error ?? "Could not mark it resolved.");
      toast.success("Marked resolved.");
      setItems((prev) => prev?.filter((i) => i.flagId !== item.flagId) ?? null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not mark it resolved.");
      load();
    } finally {
      setBusy(null);
    }
  }

  // A load failure must be visible: this is the only place these flags show.
  if (error) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        {title}: {error}
      </div>
    );
  }
  if (!items || items.length === 0) return null;

  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-400">
        <AlertTriangle className="h-4 w-4" />
        {title} ({items.length})
      </h2>
      <ul className="divide-y rounded-2xl border border-amber-500/30 bg-amber-500/5">
        {items.map((item) => {
          const who = item.subAccountId
            ? nameFor?.(item.subAccountId)
            : item.candidates.length > 0
              ? item.candidates.map((id) => nameFor?.(id) ?? id).join(", ")
              : null;
          return (
            <li key={item.flagId} className="flex flex-col gap-2 p-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-1 text-sm">
                {who && <p className="font-medium">{who}</p>}
                <p>{item.reason}</p>
                <p className="text-xs text-muted-foreground">
                  {item.amountCents !== null && <>{formatBillingPrice(item.amountCents, item.currency)} · </>}
                  {item.reference && <span className="break-all font-mono">{item.reference}</span>}
                  {item.createdAtMs !== null && <> · {new Date(item.createdAtMs).toLocaleString("en-GB")}</>}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                disabled={busy === item.flagId}
                onClick={() => void resolve(item)}
              >
                Mark resolved
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
