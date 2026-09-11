"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { Building2, Globe, Mail, MapPin, Pencil, Phone, Trash2 } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useSubAccount } from "@/context/sub-account-context";
import { subscribeToCompany, updateCompany } from "@/lib/firestore/companies";
import { subscribeToContacts } from "@/lib/firestore/contacts";
import { useEffectiveTerritoryFilter } from "@/hooks/use-effective-territory-filter";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { CompanyForm } from "@/components/companies/company-form";
import { CompanyContactsTable } from "@/components/companies/company-contacts-table";
import type { Company, CompanyFormData } from "@/types/companies";
import type { Contact } from "@/types/contacts";

export default function CompanyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const { subAccountId, agencyId, isAdmin, saPath } = useSubAccount();
  const { ready: filterReady, filter: territoryFilter } =
    useEffectiveTerritoryFilter();
  const [company, setCompany] = useState<Company | null>(null);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (authLoading || !user || !id) return;
    return subscribeToCompany(
      id,
      (c) => {
        setCompany(c);
        setLoading(false);
      },
      // Rules deny the read on a foreign or missing doc, so this — not the
      // null callback — is how the not-found state is reached by URL.
      () => {
        setCompany(null);
        setLoading(false);
      },
    );
  }, [id, user, authLoading]);

  useEffect(() => {
    if (authLoading || !user || !agencyId || !filterReady || !id) return;
    return subscribeToContacts(
      { agencyId, subAccountId },
      { territoryFilter, companyId: id },
      setContacts,
      () => toast.error("Couldn't load this company's contacts."),
    );
  }, [id, user, agencyId, subAccountId, authLoading, filterReady, territoryFilter]);

  async function handleSave(data: CompanyFormData) {
    await updateCompany(id, data);
    toast.success("Company updated");
    setEditing(false);
  }

  async function confirmDelete() {
    setDeleting(true);
    try {
      const res = await fetch(`/api/companies/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(payload.error ?? "Couldn't delete company.");
        return;
      }
      toast.success(`Deleted ${company?.name ?? "company"}.`);
      router.push(saPath("/companies"));
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-4">
        <div className="h-8 w-64 animate-pulse rounded bg-muted" />
        <div className="h-40 w-full animate-pulse rounded-xl bg-muted" />
      </div>
    );
  }

  if (!company) {
    return (
      <div className="mx-auto w-full max-w-5xl">
        <div className="mx-auto max-w-md rounded-xl border border-dashed bg-card/50 p-12 text-center">
          <Building2 className="mx-auto mb-4 h-6 w-6 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Company not found</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            This company may have been deleted or you don&apos;t have access.
          </p>
          <Button render={<Link href={saPath("/companies")} />} className="mt-6">
            Back to companies
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <div className="rounded-xl border bg-card p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <Link
              href={saPath("/companies")}
              className="text-xs text-muted-foreground hover:underline"
            >
              ← Companies
            </Link>
            <h1 className="mt-1 text-2xl font-bold tracking-tight">
              {company.name}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => setEditing(true)}>
              <Pencil className="mr-1 h-4 w-4" />
              Edit
            </Button>
            {isAdmin && (
              <Button variant="outline" onClick={() => setDeleteOpen(true)}>
                <Trash2 className="mr-1 h-4 w-4" />
                Delete
              </Button>
            )}
          </div>
        </div>
        <dl className="mt-6 grid gap-3 text-sm sm:grid-cols-2">
          <Field icon={<Phone className="h-4 w-4" />} label="Phone" value={company.phone} />
          <Field icon={<Mail className="h-4 w-4" />} label="Email" value={company.email} />
          <Field icon={<Globe className="h-4 w-4" />} label="Website" value={company.website} />
          <Field icon={<MapPin className="h-4 w-4" />} label="Address" value={company.address} />
        </dl>
      </div>

      <div className="space-y-3">
        <h2 className="text-lg font-semibold">
          Contacts <span className="text-muted-foreground">({contacts.length})</span>
        </h2>
        <CompanyContactsTable contacts={contacts} />
      </div>

      <Sheet open={editing} onOpenChange={setEditing}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>Edit Company</SheetTitle>
            <SheetDescription>Update {company.name}&apos;s details.</SheetDescription>
          </SheetHeader>
          <div className="p-4 pt-0">
            <CompanyForm
              initial={company}
              submitLabel="Save Changes"
              onSubmit={handleSave}
              onCancel={() => setEditing(false)}
            />
          </div>
        </SheetContent>
      </Sheet>

      <Dialog open={deleteOpen} onOpenChange={(o) => !deleting && setDeleteOpen(o)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete company?</DialogTitle>
            {/* `contacts.length` is what this caller can see (territory-
                filtered); the server unlinks every contact in the sub-account,
                so a collaborator may see a smaller number than gets unlinked. */}
            <DialogDescription>
              {company.name} will be removed and its {contacts.length} linked
              contact{contacts.length === 1 ? "" : "s"} unlinked. The contacts
              themselves are kept.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteOpen(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete company"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 text-muted-foreground">{icon}</span>
      <div>
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd className="whitespace-pre-line text-foreground">{value || "—"}</dd>
      </div>
    </div>
  );
}
