"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Download, Mail, PhoneOutgoing, Search, Upload } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/use-auth";
import { useSubAccount } from "@/context/sub-account-context";
import { subscribeToContacts } from "@/lib/firestore/contacts";
import { subscribeToTerritories } from "@/lib/firestore/territories";
import { useSmartLists } from "@/hooks/use-smart-lists";
import { applyFilters, matchesSearch } from "@/lib/contacts/filter";
import { useContactSelection } from "@/hooks/use-contact-selection";
import { useSubAccountMembers } from "@/hooks/use-sub-account-members";
import { useEffectiveTerritoryFilter } from "@/hooks/use-effective-territory-filter";
import { useContactsPreview } from "@/hooks/use-contacts-preview";
import { RENDER_STEP } from "@/components/show-more-rows";
import { serializeCsv, downloadCsv } from "@/lib/csv";
import { toDate } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ContactsTable } from "@/components/contacts/contacts-table";
import { AddContactModal } from "@/components/contacts/add-contact-modal";
import { ImportContactsDialog } from "@/components/contacts/import-contacts-dialog";
import { BulkEmailDialog } from "@/components/contacts/bulk-email-dialog";
import { BulkCallDialog } from "@/components/contacts/bulk-call-dialog";
import { ContactFiltersPanel } from "@/components/contacts/contact-filters-panel";
import { SmartListTabs } from "@/components/contacts/smart-list-tabs";
import { BulkActionsBar } from "@/components/contacts/bulk-actions-bar";
import {
  ContactsLoading,
  EmptyState,
} from "@/components/contacts/contacts-empty-states";
import type { Contact } from "@/types/contacts";
import type { TerritoryDoc } from "@/types";

/**
 * Reads ?import=1 from the URL, opens the import dialog, then strips the
 * param so closing the dialog doesn't get fought by the next render. Also
 * mirrors ?list=<id> (the selected smart list) into page state so a tab is
 * deep-linkable.
 *
 * Lifted into its own component so we can wrap it in <Suspense> —
 * useSearchParams() bails out of static rendering otherwise.
 */
function QueryWatcher({
  onOpen,
  onList,
}: {
  onOpen: () => void;
  onList: (id: string | null) => void;
}) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  useEffect(() => {
    onList(searchParams.get("list"));
  }, [searchParams, onList]);
  useEffect(() => {
    if (searchParams.get("import") !== "1") return;
    onOpen();
    // Replace the URL without the import param so this effect doesn't
    // re-open the dialog every time the user closes it.
    const next = new URLSearchParams(searchParams);
    next.delete("import");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }, [searchParams, pathname, router, onOpen]);
  return null;
}

export default function ContactsPage() {
  const { user, loading: authLoading } = useAuth();
  const { subAccountId, agencyId, subAccount, isAdmin } = useSubAccount();
  const scopingOn = subAccount?.territoryScopingEnabled === true;
  const { ready: filterReady, filter: territoryFilter } =
    useEffectiveTerritoryFilter();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [territories, setTerritories] = useState<TerritoryDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [bulkEmailOpen, setBulkEmailOpen] = useState(false);
  const [bulkCallOpen, setBulkCallOpen] = useState(false);
  const outboundVoiceOn = subAccount?.outboundVoiceEnabledByAgency === true;
  const openImport = useCallback(() => setImportOpen(true), []);
  const {
    filters,
    setFilters,
    lists,
    activeListId,
    setActiveListId,
    selectList,
    saveList,
    renameList,
    deleteList,
  } = useSmartLists({ agencyId, subAccountId, uid: user?.uid ?? null });
  // What the table shows: smart-list filters, then the quick search.
  const visible = useMemo(
    () => applyFilters(contacts, filters).filter((c) => matchesSearch(c, search)),
    [contacts, filters, search],
  );
  const visibleIds = useMemo(() => visible.map((c) => c.id), [visible]);
  const selection = useContactSelection(visibleIds);
  // Newest page while the full list loads — only when it is exactly what the
  // table will show: no territory narrowing, smart-list filter or search.
  const preview = useContactsPreview(
    agencyId ? { agencyId, subAccountId } : null,
    RENDER_STEP,
    loading && filterReady && !!user && !territoryFilter &&
      !filters.all?.length && !search.trim(),
  );
  const { members } = useSubAccountMembers(subAccountId);
  const selectedContacts = useMemo(
    () => visible.filter((c) => selection.selected.has(c.id)),
    [visible, selection.selected],
  );

  useEffect(() => {
    if (authLoading || !user || !agencyId) return;
    if (!filterReady) return;
    setLoading(true);
    const unsub = subscribeToContacts(
      { agencyId, subAccountId },
      { territoryFilter, waitForServer: true },
      (list) => {
        setContacts(list);
        setLoading(false);
      },
    );
    return () => unsub();
  }, [
    user,
    agencyId,
    subAccountId,
    authLoading,
    filterReady,
    territoryFilter,
  ]);

  useEffect(() => {
    if (!scopingOn || !subAccountId) {
      setTerritories([]);
      return;
    }
    const unsub = subscribeToTerritories(subAccountId, (list) =>
      setTerritories(list),
    );
    return () => unsub();
  }, [scopingOn, subAccountId]);

  function handleExport() {
    // The selection when there is one, otherwise everything on screen.
    const source = selectedContacts.length > 0 ? selectedContacts : visible;
    if (source.length === 0) {
      toast.error("No contacts to export.");
      return;
    }
    const headers = ["name", "email", "phone", "company", "source", "tags", "pipelineStage", "assignedTo", "createdAt"];
    // Export what the current tab + filters show, not the whole workspace.
    const rows = source.map((c) => ({
      name: c.name,
      email: c.email,
      phone: c.phone,
      company: c.company,
      source: c.source,
      tags: c.tags ?? [],
      pipelineStage: c.pipelineStage ?? "",
      // Member name, not uid — a uid means nothing outside this workspace.
      assignedTo: c.assignedToUid
        ? (members.find((m) => m.uid === c.assignedToUid)?.displayName ?? "")
        : "",
      createdAt: toDate(c.createdAt)?.toISOString() ?? "",
    }));
    const csv = serializeCsv(headers, rows);
    const stamp = new Date().toISOString().slice(0, 10);
    downloadCsv(`leadstack-contacts-${stamp}.csv`, csv);
    toast.success(`Exported ${rows.length} contacts`);
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <Suspense fallback={null}>
        <QueryWatcher onOpen={openImport} onList={setActiveListId} />
      </Suspense>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Contacts</h1>
          <p className="text-sm text-muted-foreground">
            Everyone in your pipeline, in one place.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() => setBulkEmailOpen(true)}
            disabled={contacts.length === 0}
          >
            <Mail className="mr-1 h-4 w-4" />
            Send bulk email
          </Button>
          {outboundVoiceOn && (
            <Button
              variant="outline"
              onClick={() => setBulkCallOpen(true)}
              disabled={contacts.length === 0}
            >
              <PhoneOutgoing className="mr-1 h-4 w-4" />
              Bulk AI call
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => setImportOpen(true)}
          >
            <Upload className="mr-1 h-4 w-4" />
            Import CSV
          </Button>
          <Button
            variant="outline"
            onClick={handleExport}
            disabled={visible.length === 0}
          >
            <Download className="mr-1 h-4 w-4" />
            Export
          </Button>
          <AddContactModal />
        </div>
      </div>

      <SmartListTabs
        lists={lists}
        activeId={activeListId}
        onSelect={selectList}
        canSave={(filters.all?.length ?? 0) > 0}
        onSave={saveList}
        onRename={renameList}
        onDelete={deleteList}
      />

      <div className="flex flex-wrap items-start gap-2">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, email, phone, or company"
            className="pl-8"
          />
        </div>
        <ContactFiltersPanel value={filters} onChange={setFilters} />
      </div>

      <BulkActionsBar
        contacts={selectedContacts}
        allContacts={contacts}
        canDelete={isAdmin}
        onClear={selection.clear}
        onKeepOnly={selection.keepOnly}
        onExport={handleExport}
      />

      {loading ? (
        <ContactsLoading preview={preview} territories={territories} />
      ) : contacts.length === 0 ? (
        <EmptyState onImport={() => setImportOpen(true)} />
      ) : visible.length === 0 ? (
        <div className="rounded-xl border bg-card p-12 text-center">
          <p className="text-sm text-muted-foreground">
            No contacts match the current search or filters.
          </p>
        </div>
      ) : (
        <ContactsTable
          contacts={visible}
          selected={selection.selected}
          onToggle={selection.toggle}
          onToggleAll={selection.allSelected ? selection.clear : selection.selectAll}
          allSelected={selection.allSelected}
          someSelected={selection.selected.size > 0}
          territories={territories}
        />
      )}

      <ImportContactsDialog open={importOpen} onOpenChange={setImportOpen} />
      <BulkEmailDialog
        open={bulkEmailOpen}
        onOpenChange={setBulkEmailOpen}
        contacts={contacts}
      />
      {outboundVoiceOn && (
        <BulkCallDialog
          open={bulkCallOpen}
          onOpenChange={setBulkCallOpen}
          contacts={contacts}
        />
      )}
    </div>
  );
}
