"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Globe, Phone } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import type { Company } from "@/types/companies";

interface Props {
  companies: Company[];
  /** contacts-per-company, keyed by company id (missing = 0). */
  contactCounts: Map<string, number>;
  search: string;
}

export function CompaniesTable({ companies, contactCounts, search }: Props) {
  const { saPath } = useSubAccount();
  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return companies;
    return companies.filter((c) =>
      [c.name, c.phone, c.website, c.email].some((v) =>
        v?.toLowerCase().includes(needle),
      ),
    );
  }, [companies, search]);

  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground py-8 text-center text-sm">
        No companies match &ldquo;{search}&rdquo;.
      </p>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <table className="w-full text-sm">
        <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-4 py-3 font-medium">Name</th>
            <th className="px-4 py-3 font-medium">Phone</th>
            <th className="px-4 py-3 font-medium">Website</th>
            <th className="px-4 py-3 text-right font-medium">Contacts</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((c) => (
            <tr key={c.id} className="hover:bg-muted/30">
              <td className="px-4 py-3">
                <Link
                  href={saPath(`/companies/${c.id}`)}
                  className="font-medium text-foreground hover:text-primary hover:underline"
                >
                  {c.name}
                </Link>
              </td>
              <td className="px-4 py-3 text-muted-foreground">
                {c.phone ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Phone className="h-3.5 w-3.5" />
                    {c.phone}
                  </span>
                ) : (
                  "—"
                )}
              </td>
              <td className="px-4 py-3 text-muted-foreground">
                {c.website ? (
                  <span className="inline-flex items-center gap-1.5">
                    <Globe className="h-3.5 w-3.5" />
                    {c.website}
                  </span>
                ) : (
                  "—"
                )}
              </td>
              <td className="px-4 py-3 text-right tabular-nums">
                {contactCounts.get(c.id) ?? 0}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
