"use client";

import { useMemo } from "react";
import Link from "next/link";
import { Repeat } from "lucide-react";

import { Button } from "@/components/ui/button";
import { RecurringInvoiceList } from "@/components/quotes/recurring-invoice-list";
import { useSubAccount } from "@/context/sub-account-context";
import { useSubAccountContacts } from "@/context/contacts-context";

/** Every standing billing instruction in this workspace. */
export default function RecurringInvoicesPage() {
  const { subAccountId, saPath } = useSubAccount();
  const { contacts } = useSubAccountContacts();

  const contactNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const c of contacts) {
      map[c.id] = c.name || c.email || c.phone || "(unnamed contact)";
    }
    return map;
  }, [contacts]);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Recurring invoices
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Retainers and subscriptions that invoice themselves. Each cycle
            raises a numbered invoice from the template and emails it with the
            usual payment link — unless the schedule is set to review first.
          </p>
        </div>
        <Button render={<Link href={saPath("/quotes/recurring/new")} />}>
          <Repeat className="h-4 w-4" />
          New schedule
        </Button>
      </div>

      <RecurringInvoiceList
        subAccountId={subAccountId}
        contactNames={contactNames}
        saPath={saPath}
      />
    </div>
  );
}
