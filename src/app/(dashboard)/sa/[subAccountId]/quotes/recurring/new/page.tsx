"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";

import { QuoteBuilder, type QuoteFormValues } from "@/components/quotes/quote-builder";
import { RecurringScheduleFields } from "@/components/quotes/recurring-schedule-fields";
import {
  defaultScheduleValues,
  schedulePayload,
  type ScheduleFormValues,
} from "@/lib/recurring/schedule-form";
import { Card } from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";
import { useSubAccount } from "@/context/sub-account-context";
import { canPayInvoice } from "@/lib/payments/can-take-payment";
import { useSubAccountContacts } from "@/context/contacts-context";
import { subscribeToProducts } from "@/lib/firestore/products";
import type { Product } from "@/types/products";

/**
 * New recurring invoice: the ordinary invoice builder for the template, plus
 * the cadence. Saving writes one schedule document; the first invoice is
 * raised by the nightly run on the date the schedule says, not now.
 */
export default function NewRecurringInvoicePage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading: authLoading } = useAuth();
  const { subAccountId, agencyId, saPath, subAccount } = useSubAccount();
  const paymentReady = canPayInvoice(subAccount);

  const { contacts } = useSubAccountContacts();
  const [products, setProducts] = useState<Product[]>([]);
  const [contactId, setContactId] = useState(searchParams.get("contactId") ?? "");
  // Defaults follow the workspace doc until the operator edits the schedule:
  // on a hard load the doc arrives after mount, and defaults captured at mount
  // would bill in UTC instead of the workspace's timezone.
  const [editedSchedule, setSchedule] = useState<ScheduleFormValues | null>(null);
  const schedule =
    editedSchedule ?? defaultScheduleValues(subAccount?.timezone ?? "UTC");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (authLoading || !user || !agencyId) return;
    const unsubP = subscribeToProducts({ agencyId, subAccountId }, (all) =>
      setProducts(all.filter((p) => p.active)),
    );
    return () => {
      unsubP();
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
      throw new Error("no contact");
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/recurring-invoices`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contactId,
            ...schedulePayload(schedule),
            lineItems: values.lineItems,
            currency: values.currency,
            globalDiscount: values.globalDiscount,
            globalTaxPercent: values.globalTaxPercent,
            termsAndNotes: values.termsAndNotes,
            billedToOrganization: values.billedToOrganization,
            billingAddress: values.billingAddress,
            paymentDueDays: values.paymentDueDays,
          }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Create failed (HTTP ${res.status})`);
      }
      router.push(saPath("/quotes/recurring"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed");
      throw err; // bubble so the builder clears its own saving state
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          New recurring invoice
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Build the invoice once. Each cycle raises a fresh numbered copy and
          emails it to the contact.
        </p>
      </div>

      {!paymentReady && (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="flex-1 text-sm">
            <p className="font-semibold text-amber-700 dark:text-amber-400">
              No payment method is connected for this workspace.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Every cycle will raise an invoice it cannot send until Paystack,
              Stripe or PayPal is connected.{" "}
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
            <Link className="text-primary underline" href={saPath("/contacts")}>
              Add a contact first.
            </Link>
          </p>
        </Card>
      ) : (
        <>
          <RecurringScheduleFields values={schedule} onChange={setSchedule} />
          <QuoteBuilder
            kind="invoice"
            contactName={contactName}
            contacts={contacts}
            selectedContactId={contactId}
            onContactChange={setContactId}
            products={products}
            onSave={handleCreate}
            onCancel={() => router.push(saPath("/quotes/recurring"))}
            saveLabel={submitting ? "Creating…" : "Create schedule"}
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
