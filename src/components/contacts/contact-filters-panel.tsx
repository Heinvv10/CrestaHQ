"use client";

import { useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConditionsEditor } from "@/components/workflows/conditions-editor";
import type { ConditionGroup } from "@/types/workflows";

export const EMPTY_FILTERS: ConditionGroup = { all: [] };

/**
 * "Filters" toggle + the inline condition builder. Reuses the workflow
 * ConditionsEditor so a list filter and a trigger filter are literally the
 * same shape (and evaluated by the same code — see lib/contacts/filter.ts).
 */
export function ContactFiltersPanel({
  value,
  onChange,
}: {
  value: ConditionGroup;
  onChange: (g: ConditionGroup) => void;
}) {
  const [open, setOpen] = useState(false);
  const count = value.all.length;

  return (
    <div className="space-y-3">
      <Button
        type="button"
        variant={count > 0 ? "secondary" : "outline"}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <SlidersHorizontal className="mr-1 h-4 w-4" />
        Filters{count > 0 ? ` (${count})` : ""}
      </Button>
      {open && (
        <div className="rounded-xl border bg-card p-4" data-testid="contact-filters">
          <ConditionsEditor
            value={value}
            onChange={onChange}
            emptyHint="No filters — showing every contact."
          />
          {count > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-2"
              onClick={() => onChange(EMPTY_FILTERS)}
            >
              Clear filters
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
