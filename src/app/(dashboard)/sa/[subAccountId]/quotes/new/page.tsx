"use client";

import { useEffect, useMemo, useState } from "react";
import { canTakePayment } from "@/lib/payments/can-take-payment";
import { useRouter, useSearchParams } from "next/navigation";

import Link from "next/link";
import { AlertTriangle } from "lucide-react";

import { QuoteBuilder, type QuoteFormValues } from "@/components/quotes/quote-builder";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { useSubAccount } from "@/context/sub-account-context";
import { subscribeToContacts } from "@/lib/firestore/contacts";
import { subscribeToDeals } from "@/lib/firestore/deals";
import { subscribeToProducts } from "@/lib/firestore/products";
import type { Contact } from "@/types/contacts";
import type { Deal } from "@/types/deals";
import type { Product } from "@/types/products";
import type { QuoteKind } from "@/types/quotes";

/**
 * New-quote flow:
 *
 *   1. Resolve contactId. If the URL already has `?contactId=…` (the
 *      "+ Quote" entry point from a contact profile), skip step 2.
 *      Otherwise show a contact picker.
 *   2. Mount <QuoteBuilder> for that contact. Save → POST create →
 *      redirect to the new quote's detail page.
 *
 * Kept deliberately thin — all the form complexity lives in the builder
 * component; this page just resolves the contact + handles the API call.
 */
export default function NewQuotePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading: authLoading } = useAuth();
  const { subAccountId, agencyId, saPath, subAccount } = useSubAccount();
  // Either rail lets an invoice be sent — card is offered on the public
  // invoice page, paypal.me mints a link at send time.
  const paymentReady = canTakePayment(subAccount);

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [contactId, setContactId] = useState<string>(
    searchParams.get("contactId") ?? "",
  );
  const initialKind: QuoteKind =
    searchParams.get("kind") === "invoice" ? "invoice" : "quote";
  const [kind, setKind] = useState<QuoteKind>(initialKind);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading || !user || !agencyId) return;
    const unsubC = subscribeToContacts({ agencyId, subAccountId }, setContacts);
    const unsubP = subscribeToProducts({ agencyId, subAccountId }, (all) =>
      setProducts(all.filter((p) => p.active)),
    );
    // Feeds the builder's "link to pipeline deal" picker. On error
    // (e.g. a territory-scoped collaborator) deals stay empty and the
    // picker simply doesn't render — same as before the picker existed.
    const unsubD = subscribeToDeals({ agencyId, subAccountId }, setDeals);
    return () => {
      unsubC();
      unsubP();
      unsubD();
    };
  }, [user, agencyId, subAccountId, authLoading]);

  const selectedContact = useMemo(
    () => contacts.find((c) => c.id === contactId) ?? null,
    [contacts, contactId],
  );
  const contactName = selectedContact
    ? selectedContact.name ||
      selectedContact.email ||
      selectedContact.phone ||
      "(unnamed contact)"
    : "";

  const handleCreate = async (values: QuoteFormValues) => {
    if (!contactId) {
      setError("Pick a contact first.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/quotes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactId,
          kind,
          lineItems: values.lineItems,
          currency: values.currency,
          globalDiscount: values.globalDiscount,
          globalTaxPercent: values.globalTaxPercent,
          termsAndNotes: values.termsAndNotes,
          billedToOrganization: values.billedToOrganization,
          billingAddress: values.billingAddress,
          validUntilDateString: values.validUntilDateString,
          paymentDueDays: values.paymentDueDays,
          autoCreateDealOnAccept: values.autoCreateDealOnAccept,
          dealId: values.dealId,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Create failed (HTTP ${res.status})`);
      }
      const created = (await res.json()) as { id: string };
      router.push(saPath(`/quotes/${created.id}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed");
      throw err; // bubble so the builder shows its own state
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          New {kind}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {kind === "invoice"
            ? "Build the line items and totals. Save as draft now — sending emails the recipient a payment link (Stripe or PayPal, whichever is connected under Settings → Payments)."
            : "Build the line items, totals, and terms. Save as a draft now — send to the recipient when you're ready."}
        </p>
      </div>

      <Card className="p-5">
        <Label className="text-xs uppercase tracking-wider text-muted-foreground">
          Type
        </Label>
        <div className="mt-2 inline-flex rounded-lg border bg-muted/30 p-1">
          {(["quote", "invoice"] as QuoteKind[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium capitalize transition ${
                kind === k
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {k}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {kind === "invoice"
            ? "Skip the estimate step — go straight to a payable invoice."
            : "Send an estimate that the recipient can accept or decline. Convert to an invoice once accepted."}
        </p>
      </Card>

      {kind === "invoice" && !paymentReady && (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="flex-1 text-sm">
            <p className="font-semibold text-amber-700 dark:text-amber-400">
              No payment method is connected for this workspace.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              You can save this invoice as a draft, but you won&apos;t be able
              to send it until Stripe or PayPal is connected.{" "}
              <Link
                href={saPath("/dashboard/settings")}
                className="font-medium text-amber-700 underline-offset-4 hover:underline dark:text-amber-400"
              >
                Connect a payment method →
              </Link>
            </p>
          </div>
        </div>
      )}

      {contacts.length === 0 ? (
        <Card className="p-5">
          <p className="text-sm text-muted-foreground">
            No contacts in this sub-account yet.{" "}
            <a
              className="text-primary underline"
              href={saPath("/contacts")}
            >
              Add a contact first.
            </a>
          </p>
        </Card>
      ) : (
        <>
          <QuoteBuilder
            kind={kind}
            contactName={contactName}
            contacts={contacts}
            selectedContactId={contactId}
            onContactChange={setContactId}
            products={products}
            deals={deals}
            onSave={handleCreate}
            onCancel={() => router.push(saPath("/quotes"))}
            saveLabel={submitting ? "Creating…" : "Create draft"}
          />
          {error && (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          )}
        </>
      )}
    </div>
  );
}
