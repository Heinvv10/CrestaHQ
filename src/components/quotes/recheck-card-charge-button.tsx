"use client";

import { useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";

const OUTCOME: Record<string, string> = {
  paid: "Paystack confirmed the charge: the invoice is now paid.",
  declined: "Paystack says the charge did not go through. You can now send the invoice with a pay link.",
  pending: "Paystack has no final answer yet. Nothing was changed — check again later.",
  needs_attention: "Paystack reports a payment that couldn't be recorded against this invoice. See the Task it raised.",
};

/**
 * "Re-check card charge" on an invoice whose recurring card charge is still
 * pending or unconfirmed. The server asks Paystack and records its answer;
 * the invoice view updates from its live subscription.
 */
export function RecheckCardChargeButton({ subAccountId, invoiceId }: { subAccountId: string; invoiceId: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const recheck = async () => {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/quotes/${invoiceId}/recheck-card-charge`, {
        method: "POST",
      });
      const body = (await res.json().catch(() => ({}))) as { outcome?: string; error?: string };
      if (!res.ok || !body.outcome) throw new Error(body.error ?? `Re-check failed (HTTP ${res.status})`);
      setMessage(OUTCOME[body.outcome] ?? `Paystack answered: ${body.outcome}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Re-check failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex w-full flex-col gap-2 sm:w-auto">
      <Button type="button" variant="outline" size="sm" onClick={() => void recheck()} disabled={busy}>
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        Re-check card charge
      </Button>
      {message && <p className="text-xs text-muted-foreground">{message}</p>}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
