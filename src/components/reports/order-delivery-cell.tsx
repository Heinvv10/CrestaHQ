"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { orderDeliverable, orderDelivers } from "@/lib/products/order-delivery";
import type { Order } from "@/types/orders";

/**
 * Reports → Payments: what a paid product order delivered, and (for admins)
 * the "Re-send delivery" action. The button only shows for an order the
 * server would re-send (paid, not held, no open flag); the route re-checks.
 */
export function OrderDeliveryCell({
  order,
  subAccountId,
  canManage,
}: {
  order: Order;
  subAccountId: string;
  canManage: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  if (!orderDelivers(order) || !order.deliveries?.length) return null;

  const status = order.deliveryStatus;
  const failed = status?.state === "failed";

  async function resend() {
    setBusy(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/orders/${order.id}/redeliver`, {
        method: "POST",
      });
      const d = (await res.json().catch(() => ({}))) as { error?: string; failed?: number };
      if (!res.ok) throw new Error(d.error ?? "Could not re-send the delivery.");
      const text = d.failed ? "Re-sent, but a delivery failed again. Check the message above." : "Delivery re-sent.";
      setResult(text);
      if (d.failed) toast.error(text);
      else toast.success(text);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not re-send the delivery.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="mt-1 block max-w-xs text-[11px]">
      {status && (
        <span className={failed ? "block text-rose-600 dark:text-rose-400" : "block text-muted-foreground"}>
          {failed ? `Delivery failed: ${status.error ?? "unknown error"}` : "Delivered"}
        </span>
      )}
      {result && <span className="block text-muted-foreground">{result}</span>}
      {canManage && orderDeliverable(order) && (
        <Button type="button" size="xs" variant="outline" className="mt-1" disabled={busy} onClick={() => void resend()}>
          Re-send delivery
        </Button>
      )}
    </span>
  );
}
