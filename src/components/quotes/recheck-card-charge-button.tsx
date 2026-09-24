"use client";

import { useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";

const OUTCOME: Record<string, string> = {
  paid: "Paystack confirmed the charge: the invoice is now paid.",
  declined: "Paystack says the charge did not go through. You can now send the invoice with a pay link.",
  failed_but_paid:
    "Paystack says the card charge failed, but this invoice was already marked paid by hand. Confirm the payment you recorded.",
  pending: "Paystack has no final answer yet. Nothing was changed — check again later.",
  needs_attention: "Paystack reports a payment that couldn't be recorded against this invoice. See the Task it raised.",
};

/**
 * "Re-check card charge" on an invoice whose recurring card charge is still
 * pending or unconfirmed. The server asks Paystack and records its answer;
 * the invoice view updates from its live subscription.
 *
 * The answer is handed to the parent rather than shown here: once the charge
 * is settled or declined the parent stops rendering this button, and a
 * message kept in its state would vanish with it.
 */
export function RecheckCardChargeButton({
  subAccountId,
  invoiceId,
  onMessage,
  onError,
}: {
  subAccountId: string;
  invoiceId: string;
  onMessage: (message: string) => void;
  onError: (error: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  const recheck = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/quotes/${invoiceId}/recheck-card-charge`, {
        method: "POST",
      });
      const body = (await res.json().catch(() => ({}))) as { outcome?: string; error?: string };
      if (!res.ok || !body.outcome) throw new Error(body.error ?? `Re-check failed (HTTP ${res.status})`);
      onMessage(OUTCOME[body.outcome] ?? `Paystack answered: ${body.outcome}.`);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Re-check failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button type="button" variant="outline" size="sm" onClick={() => void recheck()} disabled={busy}>
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
      Re-check card charge
    </Button>
  );
}
