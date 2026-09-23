"use client";

import { useEffect, useState } from "react";
import { CreditCard, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { subscribeToContactMandates } from "@/lib/firestore/payment-mandates";
import { formatCurrency } from "@/lib/format";
import type { PaymentMandate } from "@/types/payment-mandates";

/**
 * Saved cards (Paystack mandates) for one contact, on the contact profile.
 * Renders nothing until the contact has one. Revoke is one click and cannot
 * be undone — the authorization is deleted server-side.
 */
export function ContactPaymentMandates({ subAccountId, contactId }: { subAccountId: string; contactId: string }) {
  const [mandates, setMandates] = useState<PaymentMandate[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () =>
      subscribeToContactMandates(subAccountId, contactId, setMandates, (err) =>
        setError(`Couldn't load saved cards: ${err.message}`),
      ),
    [subAccountId, contactId],
  );

  if (mandates.length === 0 && !error) return null;

  const revoke = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/payment-mandates/${id}/revoke`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Failed (HTTP ${res.status})`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't revoke the card");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className="space-y-3 p-5">
      <h2 className="text-sm font-semibold">Saved cards</h2>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {mandates.map((m) => (
        <div key={m.id} className="space-y-2 rounded-md border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="flex items-center gap-2 text-sm font-medium">
              <CreditCard className="h-4 w-4" />
              {(m.cardBrand ?? "Card").toUpperCase()} •••• {m.last4 ?? "????"}
              {m.expMonth && m.expYear ? ` · exp ${m.expMonth}/${m.expYear}` : ""}
            </p>
            <div className="flex items-center gap-2">
              {m.mode === "test" && (
                <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-400">
                  TEST MODE
                </Badge>
              )}
              {m.status === "active" ? (
                <Badge>Active</Badge>
              ) : m.status === "attention" ? (
                <Badge variant="destructive">Needs attention</Badge>
              ) : (
                <Badge variant="outline">Revoked</Badge>
              )}
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            {formatCurrency(m.terms.amountCents / 100, m.terms.currency)} {m.terms.frequency}
          </p>
          {m.attention && (
            <p className={m.status === "attention" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
              {m.attention}
            </p>
          )}
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer">Consent record</summary>
            <p className="mt-1">&ldquo;{m.consent.text}&rdquo;</p>
            <p className="mt-1">
              Accepted {toDate(m.consent.acceptedAt)?.toLocaleString() ?? "—"} from IP {m.consent.ip}
            </p>
          </details>
          {m.status !== "revoked" && (
            <Button type="button" variant="outline" size="sm" onClick={() => void revoke(m.id)} disabled={busy !== null}>
              {busy === m.id && <Loader2 className="h-4 w-4 animate-spin" />}
              Revoke card (can&apos;t be undone)
            </Button>
          )}
        </div>
      ))}
    </Card>
  );
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  const ts = value as { toDate?: () => Date } | null;
  return ts?.toDate?.() ?? null;
}
