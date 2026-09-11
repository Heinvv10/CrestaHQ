"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Building2, Plus } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import { useSubAccount } from "@/context/sub-account-context";
import { createCompany, subscribeToCompanies } from "@/lib/firestore/companies";
import type { Company } from "@/types/companies";

export interface CompanyValue {
  /** Linked `companies/{id}`, or null for legacy free text. */
  companyId: string | null;
  /** Display string — the linked company's name, or whatever was typed. */
  company: string;
}

interface Props {
  id: string;
  value: CompanyValue;
  onChange: (next: CompanyValue) => void;
}

/**
 * Company picker for the contact form. Typing keeps the legacy free-text
 * behaviour (companyId null); picking a row links it; "Create" adds the
 * company and links it in one step. A plain input + listbox rather than a
 * popover so the sheet's own scroll and focus handling stay untouched.
 */
export function CompanyCombobox({ id, value, onChange }: Props) {
  const { subAccountId, agencyId } = useSubAccount();
  const { user } = useAuth();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!subAccountId || !agencyId) return;
    return subscribeToCompanies({ agencyId, subAccountId }, setCompanies);
  }, [subAccountId, agencyId]);

  const typed = value.company.trim();
  const matches = useMemo(() => {
    const needle = typed.toLowerCase();
    return companies
      .filter((c) => !needle || c.name.toLowerCase().includes(needle))
      .slice(0, 8);
  }, [companies, typed]);
  const exact = companies.some(
    (c) => c.name.toLowerCase() === typed.toLowerCase(),
  );
  // Inline create is a client-SDK write, so it needs the resolved user.
  const showCreate =
    typed.length > 0 && !exact && !value.companyId && !!user && !!agencyId;

  function pick(c: Pick<Company, "id" | "name">) {
    onChange({ companyId: c.id, company: c.name });
    setOpen(false);
  }

  async function create() {
    if (!user || !agencyId) return;
    setCreating(true);
    try {
      const newId = await createCompany({ agencyId, subAccountId }, user.uid, {
        name: typed,
        phone: "",
        email: "",
        website: "",
        address: "",
      });
      pick({ id: newId, name: typed });
    } catch (err) {
      console.error(err);
      toast.error("Couldn't create company.");
    } finally {
      setCreating(false);
    }
  }

  const listId = `${id}-options`;
  return (
    <div className="relative">
      <Input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        autoComplete="off"
        value={value.company}
        onChange={(e) => {
          // Any edit to the text is a new free-text value until a row is
          // picked again — otherwise a renamed string would keep the link.
          onChange({ companyId: null, company: e.target.value });
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Acme Inc."
      />
      {open && (matches.length > 0 || showCreate) && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border bg-popover p-1 text-sm shadow-md"
        >
          {matches.map((c) => (
            <li
              key={c.id}
              role="option"
              aria-selected={c.id === value.companyId}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(c)}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent"
            >
              <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
              {c.name}
            </li>
          ))}
          {showCreate && (
            <li
              role="option"
              aria-selected={false}
              aria-disabled={creating}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (!creating) void create();
              }}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-primary hover:bg-accent"
            >
              <Plus className="h-3.5 w-3.5" />
              {creating ? "Creating…" : `Create "${typed}"`}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
