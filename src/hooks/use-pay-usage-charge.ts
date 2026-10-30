"use client";

import { useState } from "react";
import { toast } from "sonner";

/** Start checkout for a usage charge and redirect. */
export function usePayUsageCharge(subAccountId: string) {
  const [paying, setPaying] = useState<string | null>(null);
  async function pay(chargeId: string) {
    setPaying(chargeId);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/billing/usage-charges/${encodeURIComponent(chargeId)}/checkout`,
        { method: "POST" },
      );
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !data.url) throw new Error(data.error ?? "Couldn't start checkout.");
      window.location.href = data.url;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't start checkout.");
      setPaying(null);
    }
  }
  return { paying, pay };
}
