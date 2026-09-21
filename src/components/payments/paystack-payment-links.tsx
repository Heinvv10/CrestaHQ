"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

import { CopyablePayUrl } from "@/components/payments/copyable-pay-url";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSubAccount } from "@/context/sub-account-context";
import { useAuth } from "@/hooks/use-auth";
import { formatCurrency, formatRelativeTime } from "@/lib/format";
import { subscribeToPaymentLinks } from "@/lib/firestore/payment-links";
import type { PaymentLink } from "@/types/payment-links";

/** Ad-hoc Paystack payment link form + every link in the workspace. */
export function PaystackPaymentLinks() {
  const { user, loading: authLoading } = useAuth();
  const { subAccountId, subAccount } = useSubAccount();
  const [links, setLinks] = useState<PaymentLink[]>([]);
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready =
    subAccount?.paymentsEnabledByAgency === true && !!subAccount?.paystackConnectionMeta;

  useEffect(() => {
    if (authLoading || !user || !subAccountId) return;
    return subscribeToPaymentLinks(subAccountId, setLinks, (err) =>
      setError(`Couldn't load payment links: ${err.message}`),
    );
  }, [user, authLoading, subAccountId]);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const rand = Number(amount.replace(/[\s,]/g, ""));
    if (!Number.isFinite(rand) || rand <= 0) {
      setError("Enter an amount in rand, e.g. 450 or 1299.99.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/payment-links`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountCents: Math.round(rand * 100), description }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `Failed (HTTP ${res.status})`);
      setAmount("");
      setDescription("");
      toast.success("Payment link created — copy it from the list below.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the link");
    } finally {
      setBusy(false);
    }
  };

  const deactivate = async (id: string) => {
    const res = await fetch(`/api/sub-accounts/${subAccountId}/payment-links/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ active: false }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      toast.error(body.error ?? "Couldn't deactivate the link");
    }
  };

  return (
    <div className="space-y-6">
      {ready ? (
        <Card className="p-4">
          <form onSubmit={create} className="grid gap-3 sm:grid-cols-[10rem_1fr_auto] sm:items-end">
            <div className="space-y-1">
              <Label htmlFor="pl-amount">Amount (ZAR)</Label>
              <Input id="pl-amount" inputMode="decimal" placeholder="450.00" value={amount} onChange={(e) => setAmount(e.target.value)} required />
            </div>
            <div className="space-y-1">
              <Label htmlFor="pl-desc">What it&apos;s for</Label>
              <Input id="pl-desc" maxLength={200} placeholder="Call-out fee" value={description} onChange={(e) => setDescription(e.target.value)} required />
            </div>
            <Button type="submit" disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              Create payment link
            </Button>
          </form>
        </Card>
      ) : (
        <Card className="p-4 text-sm text-muted-foreground">
          Connect Paystack under Settings → Payments to create payment links.
        </Card>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}

      {links.length === 0 ? (
        <Card className="p-8 text-center text-sm text-muted-foreground">No payment links yet.</Card>
      ) : (
        <div className="space-y-3">
          {links.map((link) => (
            <Card key={link.id} className="space-y-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-medium">{link.description}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatCurrency(link.amountCents / 100, link.currency)} · created{" "}
                    {formatRelativeTime(link.createdAt)}
                    {link.invoiceId ? " · invoice" : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {link.status === "paid" ? (
                    <Badge>Paid</Badge>
                  ) : link.active ? (
                    <Badge variant="secondary">Open</Badge>
                  ) : (
                    <Badge variant="outline">Deactivated</Badge>
                  )}
                  {link.status === "open" && link.active && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => void deactivate(link.id)}>
                      Deactivate
                    </Button>
                  )}
                </div>
              </div>
              {link.status === "open" && link.active && <CopyablePayUrl token={link.token} />}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
