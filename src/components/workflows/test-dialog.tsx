"use client";

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, Search } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useSubAccountContacts } from "@/context/contacts-context";
import { contactDisplayName } from "@/lib/contacts/display-name";
import type { Contact } from "@/types/contacts";

/** Rendered results are capped so a large sub-account's list stays fast; the search itself still runs over every contact. */
const RESULTS_CAP = 50;

function digitsOnly(s: string): string {
  return s.replace(/\D+/g, "");
}

/**
 * True when the typed digits and the contact's phone agree on their
 * trailing 9 digits — so a local "0823216574", a bare "823216574" and a
 * formatted "+27 82 321 6574" all match a contact stored as
 * "+27823216574", regardless of trunk prefix or country code on either
 * side. Below 4 digits either side, skip phone matching (too noisy).
 */
function phoneMatches(contactPhone: string, queryDigits: string): boolean {
  const contactDigits = digitsOnly(contactPhone);
  if (queryDigits.length < 4 || contactDigits.length < 4) return false;
  const n = Math.min(9, queryDigits.length, contactDigits.length);
  return queryDigits.slice(-n) === contactDigits.slice(-n);
}

/** Name/email/phone search behind the Test workflow contact picker. Exported for tests. */
export function filterTestContacts(contacts: Contact[], q: string): Contact[] {
  const term = q.trim().toLowerCase();
  if (!term) return contacts;
  const queryDigits = digitsOnly(term);
  return contacts.filter(
    (c) =>
      c.name.toLowerCase().includes(term) ||
      c.email.toLowerCase().includes(term) ||
      phoneMatches(c.phone, queryDigits),
  );
}

export function TestDialog({
  saId,
  workflowId,
  open,
  onOpenChange,
}: {
  saId: string;
  workflowId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { contacts, loading, error } = useSubAccountContacts(open);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  async function enroll(contactId: string) {
    setBusy(contactId);
    try {
      const res = await fetch(
        `/api/sub-accounts/${saId}/workflows/${workflowId}/test`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contactId }),
        },
      );
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(d.error ?? "Couldn't start test");
      toast.success("Test run started — check the Runs tab.");
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't start test");
    } finally {
      setBusy(null);
    }
  }

  const filtered = useMemo(() => filterTestContacts(contacts, q), [contacts, q]);
  const shown = filtered.slice(0, RESULTS_CAP);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Test workflow</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Pick a contact to enroll now. This runs the <strong>saved</strong>{" "}
          version immediately, even on a draft — save first if you have unsaved
          changes.
        </p>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search contacts…"
            className="pl-8"
          />
        </div>
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-8 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : error ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Couldn&apos;t load contacts.
            </p>
          ) : shown.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No contacts found.
            </p>
          ) : (
            <>
              {shown.map((c) => (
                <button
                  key={c.id}
                  onClick={() => enroll(c.id)}
                  disabled={busy !== null}
                  className="flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm hover:bg-muted/50 disabled:opacity-60"
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">
                      {contactDisplayName(c)}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {c.email}
                    </span>
                  </span>
                  {busy === c.id && <Loader2 className="h-4 w-4 animate-spin" />}
                </button>
              ))}
              {filtered.length > RESULTS_CAP && (
                <p className="py-2 text-center text-xs text-muted-foreground">
                  {filtered.length - RESULTS_CAP} more match — refine your search.
                </p>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
