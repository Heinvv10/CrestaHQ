"use client";

import { Upload, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AddContactModal } from "@/components/contacts/add-contact-modal";
import { ContactsTable } from "@/components/contacts/contacts-table";
import type { Contact } from "@/types/contacts";
import type { TerritoryDoc } from "@/types";

const NO_SELECTION = new Set<string>();
const noop = () => undefined;

/**
 * Loading state: the newest page once it lands, otherwise the skeleton. No
 * checkboxes: select-all must mean the full list, which has not arrived.
 */
export function ContactsLoading({
  preview,
  territories,
}: {
  preview: Contact[] | null;
  territories: TerritoryDoc[];
}) {
  if (!preview?.length) return <TableSkeleton />;
  return (
    <>
      <ContactsTable
        contacts={preview}
        selected={NO_SELECTION}
        onToggle={noop}
        onToggleAll={noop}
        allSelected={false}
        someSelected={false}
        territories={territories}
        readOnly
      />
      <p className="text-center text-xs text-muted-foreground">
        Loading all contacts…
      </p>
    </>
  );
}

export function TableSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="border-b bg-muted/40 px-4 py-3">
        <div className="h-3 w-24 animate-pulse rounded bg-muted" />
      </div>
      <div className="divide-y">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-4">
            <div className="h-4 w-40 animate-pulse rounded bg-muted" />
            <div className="h-4 w-48 animate-pulse rounded bg-muted" />
            <div className="ml-auto h-5 w-16 animate-pulse rounded-full bg-muted" />
          </div>
        ))}
      </div>
    </div>
  );
}

export function EmptyState({ onImport }: { onImport: () => void }) {
  return (
    <div className="rounded-xl border border-dashed bg-card/50 p-12 text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
        <Users className="h-6 w-6 text-primary" />
      </div>
      <h3 className="text-base font-semibold">No contacts yet</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Add your first lead or import a CSV from your old CRM.
      </p>
      <div className="mt-6 flex justify-center gap-2">
        <AddContactModal />
        <Button variant="outline" onClick={onImport}>
          <Upload className="mr-1 h-4 w-4" />
          Import CSV
        </Button>
      </div>
    </div>
  );
}
