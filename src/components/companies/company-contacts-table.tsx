"use client";

import Link from "next/link";
import { useSubAccount } from "@/context/sub-account-context";
import type { Contact } from "@/types/contacts";

/** Contacts linked to one company (company detail page). */
export function CompanyContactsTable({ contacts }: { contacts: Contact[] }) {
  const { saPath } = useSubAccount();

  if (contacts.length === 0) {
    return (
      <p className="rounded-xl border border-dashed bg-card/50 p-8 text-center text-sm text-muted-foreground">
        No contacts linked yet. Pick this company in a contact&apos;s Company
        field to link them.
      </p>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <table className="w-full text-sm">
        <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-4 py-3 font-medium">Name</th>
            <th className="px-4 py-3 font-medium">Email</th>
            <th className="px-4 py-3 font-medium">Phone</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {contacts.map((c) => (
            <tr key={c.id} className="hover:bg-muted/30">
              <td className="px-4 py-3">
                <Link
                  href={saPath(`/contacts/${c.id}`)}
                  className="font-medium text-foreground hover:text-primary hover:underline"
                >
                  {c.name || "Unnamed"}
                </Link>
              </td>
              <td className="px-4 py-3 text-muted-foreground">{c.email || "—"}</td>
              <td className="px-4 py-3 text-muted-foreground">{c.phone || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
