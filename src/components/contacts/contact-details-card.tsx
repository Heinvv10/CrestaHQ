"use client";

import { useEffect, useState } from "react";
import { ListChecks } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { subscribeToCustomFields } from "@/lib/firestore/custom-fields";
import type { Contact } from "@/types/contacts";
import type { CustomFieldDef, CustomFieldValue } from "@/types/custom-fields";

/**
 * Read-only display surface for contact custom fields. Values were
 * previously editable in the add/edit dialog and DISPLAYED nowhere — a
 * value could be typed once and never seen again without reopening Edit.
 *
 * Every definition renders, not just filled ones: a blank row (em-dash)
 * is a prompt to go and get the value. The card hides entirely in
 * workspaces that define no contact fields.
 */

function formatValue(
  def: CustomFieldDef,
  v: CustomFieldValue | undefined,
): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (Array.isArray(v)) return v.length > 0 ? v.join(", ") : null;
  if (def.type === "checkbox") return v === true ? "Yes" : "No";
  return String(v);
}

export function ContactDetailsCard({ contact }: { contact: Contact }) {
  const { subAccountId } = useSubAccount();
  const [defs, setDefs] = useState<CustomFieldDef[]>([]);

  useEffect(() => {
    if (!subAccountId) return;
    const unsub = subscribeToCustomFields(
      subAccountId,
      "contact",
      (list) => setDefs([...list].sort((a, b) => a.order - b.order)),
      () => {},
    );
    return () => unsub();
  }, [subAccountId]);

  if (defs.length === 0) return null;

  const values = (contact.customFields ?? {}) as Record<
    string,
    CustomFieldValue
  >;
  const rows = defs.map((d) => ({
    def: d,
    display: formatValue(d, values[d.key]),
  }));
  const filled = rows.filter((r) => r.display !== null).length;

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ListChecks className="h-3.5 w-3.5 text-muted-foreground" />
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Details
          </p>
        </div>
        <span className="text-[11px] text-muted-foreground">
          {filled}/{defs.length} filled
        </span>
      </div>
      <dl className="space-y-2 text-sm">
        {rows.map(({ def, display }) => (
          <div
            key={def.key}
            className="flex items-baseline justify-between gap-3"
          >
            <dt className="shrink-0 text-muted-foreground">{def.label}</dt>
            <dd
              className={
                display === null
                  ? "text-muted-foreground/60"
                  : "min-w-0 truncate text-right font-medium"
              }
              title={display ?? undefined}
            >
              {display ?? "—"}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
