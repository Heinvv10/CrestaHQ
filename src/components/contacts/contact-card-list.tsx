"use client";

import Link from "next/link";
import { Mail, Phone, Building2 } from "lucide-react";
import type { Contact } from "@/types/contacts";
import { SourceBadge } from "@/components/contacts/source-badge";
import { Checkbox } from "@/components/ui/checkbox";
import { useSubAccount } from "@/context/sub-account-context";
import { contactDisplayName } from "@/lib/contacts/display-name";

/** The `md:hidden` card rendering of the contacts list (desktop is a table). */
export function ContactCardList({
  contacts,
  selected,
  onToggle,
}: {
  contacts: Contact[];
  selected: Set<string>;
  onToggle: (id: string) => void;
}) {
  const { saPath } = useSubAccount();
  return (
    <div className="space-y-3 md:hidden">
      {contacts.map((c) => (
        <div key={c.id} className="flex items-start gap-3">
          <Checkbox
            aria-label={`Select ${contactDisplayName(c)}`}
            checked={selected.has(c.id)}
            onCheckedChange={() => onToggle(c.id)}
            className="mt-5"
          />
          <Link
            href={saPath(`/contacts/${c.id}`)}
            className="block min-w-0 flex-1 select-none rounded-xl border bg-card p-4 transition-all hover:bg-muted/30 active:scale-[0.99] active:bg-muted/40"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{contactDisplayName(c)}</p>
                {c.email && (
                  <p className="mt-1 flex items-center gap-1.5 truncate text-sm text-muted-foreground">
                    <Mail className="h-3.5 w-3.5 shrink-0" />
                    {c.email}
                  </p>
                )}
                {c.phone && (
                  <p className="mt-0.5 flex items-center gap-1.5 truncate text-sm text-muted-foreground">
                    <Phone className="h-3.5 w-3.5 shrink-0" />
                    {c.phone}
                  </p>
                )}
                {c.company && (
                  <p className="mt-0.5 flex items-center gap-1.5 truncate text-sm text-muted-foreground">
                    <Building2 className="h-3.5 w-3.5 shrink-0" />
                    {c.company}
                  </p>
                )}
              </div>
              <SourceBadge source={c.source} />
            </div>
          </Link>
        </div>
      ))}
    </div>
  );
}
