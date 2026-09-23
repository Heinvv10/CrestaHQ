"use client";

import { useState } from "react";
import { CreditCard, Link2, Loader2 } from "lucide-react";

import { CopyablePayUrl } from "@/components/payments/copyable-pay-url";
import { Button } from "@/components/ui/button";
import { useSubAccount } from "@/context/sub-account-context";

/**
 * "Paystack link" on a sent invoice: makes a payment link for the invoice's
 * total and shows the URL to copy. On an invoice a recurring schedule raised,
 * "Card-on-file link" makes one that also saves the card for later cycles.
 * Hidden unless the workspace has Paystack connected — the create route
 * refuses otherwise anyway.
 */
export function PaystackInvoiceLinkButton({ invoiceId, recurring = false }: { invoiceId: string; recurring?: boolean }) {
  const { subAccountId, subAccount } = useSubAccount();
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (subAccount?.paymentsEnabledByAgency !== true || !subAccount?.paystackConnectionMeta) {
    return null;
  }

  const create = async (mandate: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/payment-links`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ invoiceId, mandate }),
      });
      const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
      if (!res.ok || !body.token) throw new Error(body.error ?? `Failed (HTTP ${res.status})`);
      setToken(body.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the link");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex w-full flex-col gap-2 sm:w-auto">
      {!token && (
        <Button type="button" variant="outline" size="sm" onClick={() => void create(false)} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
          Paystack link
        </Button>
      )}
      {!token && recurring && (
        <Button type="button" variant="outline" size="sm" onClick={() => void create(true)} disabled={busy}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />}
          Card-on-file link
        </Button>
      )}
      {token && <CopyablePayUrl token={token} />}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
