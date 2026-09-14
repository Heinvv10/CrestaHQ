"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import type { Contact } from "@/types/contacts";
import type { TerritoryDoc } from "@/types";
import { SourceBadge } from "@/components/contacts/source-badge";
import { ContactCardList } from "@/components/contacts/contact-card-list";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { formatContactDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useSubAccount } from "@/context/sub-account-context";
import { contactDisplayName } from "@/lib/contacts/display-name";

/**
 * Rows rendered per "Show more" step. Rendering every contact froze the tab
 * for 8s on a 4,551-contact sub-account; sorting, search, filters, select-all
 * and export still run over the full list — only the DOM is capped.
 */
export const RENDER_STEP = 100;

interface Props {
  /** Already filtered by the page (search + smart list). */
  contacts: Contact[];
  /** Row selection, owned by the page (hooks/use-contact-selection). */
  selected: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  allSelected: boolean;
  /** Some, not all, visible rows selected — header shows indeterminate. */
  someSelected: boolean;
  /**
   * Optional — when the sub-account has territory scoping on, the
   * page passes the active territory list so the table can render a
   * "Territory" column. Empty array (default) hides the column.
   */
  territories?: TerritoryDoc[];
}

export function ContactsTable({
  contacts,
  selected,
  onToggle,
  onToggleAll,
  allSelected,
  someSelected,
  territories = [],
}: Props) {
  const { subAccount, saPath } = useSubAccount();
  const showTerritoryCol = subAccount?.territoryScopingEnabled === true;
  const [sorting, setSorting] = useState<SortingState>([
    { id: "createdAt", desc: true },
  ]);
  const [renderLimit, setRenderLimit] = useState(RENDER_STEP);

  const territoryById = useMemo(() => {
    const m = new Map<string, TerritoryDoc>();
    for (const t of territories) m.set(t.id, t);
    return m;
  }, [territories]);

  const columns = useMemo<ColumnDef<Contact>[]>(
    () => [
      {
        id: "select",
        enableSorting: false,
        header: () => (
          <Checkbox
            aria-label="Select all"
            checked={allSelected}
            indeterminate={someSelected && !allSelected}
            onCheckedChange={onToggleAll}
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            aria-label={`Select ${contactDisplayName(row.original)}`}
            checked={selected.has(row.original.id)}
            onCheckedChange={() => onToggle(row.original.id)}
          />
        ),
      },
      {
        accessorKey: "name",
        header: "Name",
        enableSorting: true,
        cell: ({ row }) => (
          <Link
            href={saPath(`/contacts/${row.original.id}`)}
            className="font-medium text-foreground hover:text-primary hover:underline"
          >
            {contactDisplayName(row.original)}
          </Link>
        ),
      },
      {
        accessorKey: "email",
        header: "Email",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.email ? (
            <span className="text-sm text-muted-foreground">
              {row.original.email}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          ),
      },
      {
        accessorKey: "phone",
        header: "Phone",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.phone ? (
            <span className="text-sm text-muted-foreground">
              {row.original.phone}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          ),
      },
      {
        accessorKey: "company",
        header: "Company",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.company ? (
            <span className="text-sm">{row.original.company}</span>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          ),
      },
      {
        accessorKey: "source",
        header: "Source",
        enableSorting: false,
        cell: ({ row }) => <SourceBadge source={row.original.source} />,
      },
      ...(showTerritoryCol
        ? [
            {
              accessorKey: "territoryId",
              header: "Territory",
              enableSorting: false,
              cell: ({ row }) => {
                const id = row.original.territoryId;
                const t = id ? territoryById.get(id) : null;
                // No explicit territory resolves to Global — the shared floor.
                if (!t) {
                  return <span className="text-sm">Global</span>;
                }
                return (
                  <span className="text-sm">
                    {t.name}
                    {t.status === "archived" && (
                      <span className="ml-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                        archived
                      </span>
                    )}
                  </span>
                );
              },
            } as ColumnDef<Contact>,
          ]
        : []),
      {
        accessorKey: "createdAt",
        header: "Added",
        enableSorting: true,
        sortingFn: (a, b) => {
          const aVal = toMillis(a.original.createdAt);
          const bVal = toMillis(b.original.createdAt);
          return aVal - bVal;
        },
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {formatContactDate(row.original.createdAt)}
          </span>
        ),
      },
    ],
    [saPath, showTerritoryCol, territoryById, selected, allSelected, someSelected, onToggle, onToggleAll],
  );

  const table = useReactTable({
    data: contacts,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  if (contacts.length === 0) {
    return null;
  }

  const rows = table.getRowModel().rows;
  const shownRows = rows.slice(0, renderLimit);
  const hidden = rows.length - shownRows.length;

  return (
    <>
      {/* Desktop table */}
      <div className="hidden overflow-hidden rounded-xl border bg-card md:block">
        <table className="w-full text-sm">
          <thead className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  const sorted = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      className={cn(
                        "px-4 py-3 font-semibold",
                        canSort && "cursor-pointer select-none hover:text-foreground",
                      )}
                      onClick={
                        canSort
                          ? header.column.getToggleSortingHandler()
                          : undefined
                      }
                    >
                      <span className="inline-flex items-center gap-1">
                        {flexRender(
                          header.column.columnDef.header,
                          header.getContext(),
                        )}
                        {canSort &&
                          (sorted === "asc" ? (
                            <ArrowUp className="h-3 w-3" />
                          ) : sorted === "desc" ? (
                            <ArrowDown className="h-3 w-3" />
                          ) : (
                            <ArrowUpDown className="h-3 w-3 opacity-40" />
                          ))}
                      </span>
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {shownRows.map((row) => (
              <tr
                key={row.id}
                className="border-b last:border-b-0 transition-colors hover:bg-muted/30"
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="px-4 py-3">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ContactCardList
        contacts={shownRows.map((r) => r.original)}
        selected={selected}
        onToggle={onToggle}
      />

      {hidden > 0 && (
        <div className="flex items-center justify-center gap-3 pt-3 text-xs text-muted-foreground">
          <span>
            Showing {shownRows.length} of {rows.length}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setRenderLimit((n) => n + RENDER_STEP)}
          >
            Show {Math.min(RENDER_STEP, hidden)} more
          </Button>
        </div>
      )}
    </>
  );
}

function toMillis(v: unknown): number {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  const maybe = v as { toDate?: () => Date; seconds?: number };
  if (typeof maybe.toDate === "function") return maybe.toDate().getTime();
  if (typeof maybe.seconds === "number") return maybe.seconds * 1000;
  return 0;
}
