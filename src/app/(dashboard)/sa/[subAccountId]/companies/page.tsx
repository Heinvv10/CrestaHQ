"use client";

import { useEffect, useMemo, useState } from "react";
import { Building2, Search } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { useSubAccount } from "@/context/sub-account-context";
import { subscribeToCompanies } from "@/lib/firestore/companies";
import { useSubAccountContacts } from "@/context/contacts-context";
import { Input } from "@/components/ui/input";
import { CompaniesTable } from "@/components/companies/companies-table";
import { AddCompanySheet } from "@/components/companies/add-company-sheet";
import type { Company } from "@/types/companies";

export default function CompaniesPage() {
  const { user, loading: authLoading } = useAuth();
  const { subAccountId, agencyId } = useSubAccount();
  const [companies, setCompanies] = useState<Company[]>([]);
  const { contacts, error: contactsError } = useSubAccountContacts();
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (authLoading || !user || !agencyId) return;
    setLoading(true);
    return subscribeToCompanies(
      { agencyId, subAccountId },
      (list) => {
        setCompanies(list);
        setLoading(false);
      },
      () => {
        setLoading(false);
        toast.error("Couldn't load companies.");
      },
    );
  }, [user, agencyId, subAccountId, authLoading]);

  // Same listener the contacts page uses — the count column is derived
  // client-side so it honours the caller's territory visibility.
  useEffect(() => {
    if (contactsError) toast.error("Couldn't load contact counts.");
  }, [contactsError]);

  const contactCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of contacts) {
      if (c.companyId) m.set(c.companyId, (m.get(c.companyId) ?? 0) + 1);
    }
    return m;
  }, [contacts]);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Companies</h1>
          <p className="text-sm text-muted-foreground">
            The organisations your contacts belong to.
          </p>
        </div>
        <AddCompanySheet />
      </div>

      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, phone, or website"
          className="pl-8"
        />
      </div>

      {loading ? (
        <div className="h-40 w-full animate-pulse rounded-xl bg-muted" />
      ) : companies.length === 0 ? (
        <EmptyState />
      ) : (
        <CompaniesTable
          companies={companies}
          contactCounts={contactCounts}
          search={search}
        />
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed bg-card/50 p-12 text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
        <Building2 className="h-6 w-6 text-primary" />
      </div>
      <h3 className="text-base font-semibold">No companies yet</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Add one here, or create one from a contact&apos;s Company field.
      </p>
      <div className="mt-6 flex justify-center">
        <AddCompanySheet />
      </div>
    </div>
  );
}
