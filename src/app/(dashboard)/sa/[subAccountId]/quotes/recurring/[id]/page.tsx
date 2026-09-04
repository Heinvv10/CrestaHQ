"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";

import { QuoteBuilder, type QuoteFormValues } from "@/components/quotes/quote-builder";
import { RecurringScheduleFields } from "@/components/quotes/recurring-schedule-fields";
import {
  schedulePayload,
  timestampSeconds,
  type ScheduleFormValues,
} from "@/lib/recurring/schedule-form";
import { Card } from "@/components/ui/card";
import { useAuth } from "@/hooks/use-auth";
import { useSubAccount } from "@/context/sub-account-context";
import { subscribeToContacts } from "@/lib/firestore/contacts";
import { subscribeToProducts } from "@/lib/firestore/products";
import type { Contact } from "@/types/contacts";
import type { Product } from "@/types/products";
import type { Quote } from "@/types/quotes";
import type { RecurringInvoiceDoc } from "@/types/recurring-invoices";

/**
 * Edit one schedule's template and cadence.
 *
 * Editing changes FUTURE cycles only — invoices already raised are historical
 * records of what was billed and are never rewritten from here. The contact
 * and the start date are fixed for the same reason: both are what the
 * invoices already raised were raised against.
 */
export default function EditRecurringInvoicePage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const scheduleId = params.id;
  const { user, loading: authLoading } = useAuth();
  const { subAccountId, agencyId, saPath } = useSubAccount();

  const [schedule, setSchedule] = useState<RecurringInvoiceDoc | null>(null);
  const [form, setForm] = useState<ScheduleFormValues | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/recurring-invoices/${scheduleId}`,
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Failed to load (HTTP ${res.status})`);
      }
      const data = (await res.json()) as { schedule: RecurringInvoiceDoc };
      setSchedule(data.schedule);
      setForm(toFormValues(data.schedule));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load schedule");
    }
  }, [subAccountId, scheduleId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (authLoading || !user || !agencyId) return;
    const unsubP = subscribeToProducts({ agencyId, subAccountId }, (all) =>
      setProducts(all.filter((p) => p.active)),
    );
    const unsubC = subscribeToContacts({ agencyId, subAccountId }, setContacts);
    return () => {
      unsubP();
      unsubC();
    };
  }, [user, agencyId, subAccountId, authLoading]);

  // Who is being billed. The contact is fixed for the life of the schedule, so
  // there is no picker here — but an operator editing what a customer is
  // charged has to be able to see which customer that is.
  const contactName = useMemo(() => {
    const contact = contacts.find((c) => c.id === schedule?.contactId);
    if (!contact) return "";
    return contact.name || contact.email || contact.phone || "(unnamed contact)";
  }, [contacts, schedule]);

  const initial = useMemo(
    () => (schedule ? (schedule as unknown as Quote) : undefined),
    [schedule],
  );

  const handleSave = async (values: QuoteFormValues) => {
    if (!form) return;
    setSubmitting(true);
    setError(null);
    try {
      const { startDateString: _start, timezone: _tz, ...cadenceFields } =
        schedulePayload(form);
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/recurring-invoices/${scheduleId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...cadenceFields,
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
        throw new Error(body.error ?? `Save failed (HTTP ${res.status})`);
      }
      router.push(saPath("/quotes/recurring"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
      throw err;
    } finally {
      setSubmitting(false);
    }
  };

  if (!schedule || !form) {
    return (
      <div className="mx-auto w-full max-w-5xl p-6">
        <Card className="p-6 text-sm text-muted-foreground">
          {error ?? "Loading schedule…"}
        </Card>
      </div>
    );
  }

  const editable = schedule.status === "active" || schedule.status === "paused";

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {schedule.name}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {schedule.cyclesGenerated} invoice
          {schedule.cyclesGenerated === 1 ? "" : "s"} raised so far. Changes
          apply to future cycles only.
        </p>
      </div>

      {!editable ? (
        <Card className="p-5 text-sm text-muted-foreground">
          This schedule is {schedule.status} and can no longer be changed.
        </Card>
      ) : (
        <>
          <RecurringScheduleFields
            values={form}
            onChange={setForm}
            startDateLocked
          />
          <QuoteBuilder
            kind="invoice"
            initial={initial}
            contactName={contactName}
            products={products}
            onSave={handleSave}
            onCancel={() => router.push(saPath("/quotes/recurring"))}
            saveLabel={submitting ? "Saving…" : "Save changes"}
          />
        </>
      )}

      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** The stored schedule, back in the shape the cadence form edits. */
function toFormValues(schedule: RecurringInvoiceDoc): ScheduleFormValues {
  return {
    name: schedule.name,
    cadenceUnit: schedule.cadence.unit,
    cadenceInterval: schedule.cadence.interval,
    startDateString: dayString(schedule.startAt, schedule.timezone),
    timezone: schedule.timezone,
    endMode: schedule.endMode,
    endDateString: schedule.endAt
      ? dayString(schedule.endAt, schedule.timezone)
      : "",
    maxCycles: schedule.maxCycles ?? 12,
    reviewFirst: schedule.reviewFirst,
    unpaidEscalationThreshold: schedule.unpaidEscalationThreshold,
  };
}

/** A stored schedule date as yyyy-mm-dd in its own zone, for a date input. */
function dayString(value: unknown, timezone: string): string {
  const seconds = timestampSeconds(value);
  if (seconds === null) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(seconds * 1000));
}
