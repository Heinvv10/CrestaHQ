"use client";

import { useMemo } from "react";

import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TimezoneSelect } from "@/components/ui/timezone-select";
import type { CadenceUnit } from "@/lib/recurring/cadence";
import {
  previewFirstRun,
  type ScheduleFormValues,
} from "@/lib/recurring/schedule-form";
import type { RecurringInvoiceEndMode } from "@/types/recurring-invoices";

/**
 * The schedule half of a recurring invoice: how often, from when, until when,
 * and whether a human sees each invoice before the customer does.
 *
 * The money half is the ordinary <QuoteBuilder>, unchanged — a recurring
 * invoice's template is an invoice, and giving it a second line-item editor
 * would mean two places to fix every time the first one changes.
 *
 * There is no day-of-month control. The billing day IS the start date's day,
 * which is one fact rather than two that can disagree; the preview below
 * spells out the resulting date so nothing has to be inferred.
 */

interface RecurringScheduleFieldsProps {
  values: ScheduleFormValues;
  onChange: (values: ScheduleFormValues) => void;
  /** Edit mode: the start date is history once the first invoice is raised. */
  startDateLocked?: boolean;
}

const CADENCE_LABELS: Record<CadenceUnit, string> = {
  week: "week",
  month: "month",
  quarter: "quarter",
  year: "year",
};

export function RecurringScheduleFields({
  values,
  onChange,
  startDateLocked = false,
}: RecurringScheduleFieldsProps) {
  const set = <K extends keyof ScheduleFormValues>(
    key: K,
    value: ScheduleFormValues[K],
  ) => onChange({ ...values, [key]: value });

  const firstRun = useMemo(
    () => previewFirstRun(values),
    [values],
  );

  return (
    <Card className="space-y-5 p-5">
      <div>
        <h2 className="text-sm font-semibold">Schedule</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          The invoice above is raised again on this cadence and emailed to the
          contact automatically.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="schedule-name">Schedule name</Label>
        <Input
          id="schedule-name"
          value={values.name}
          maxLength={120}
          placeholder="Acme monthly retainer"
          onChange={(e) => set("name", e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Your label for this schedule. The customer never sees it.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="schedule-interval">Bill every</Label>
          <div className="flex gap-2">
            <Input
              id="schedule-interval"
              type="number"
              min={1}
              max={52}
              className="w-20"
              value={values.cadenceInterval}
              onChange={(e) =>
                set("cadenceInterval", Math.max(1, Number(e.target.value) || 1))
              }
            />
            <select
              aria-label="Cadence unit"
              className="h-9 flex-1 rounded-md border bg-background px-3 text-sm"
              value={values.cadenceUnit}
              onChange={(e) => set("cadenceUnit", e.target.value as CadenceUnit)}
            >
              {(Object.keys(CADENCE_LABELS) as CadenceUnit[]).map((unit) => (
                <option key={unit} value={unit}>
                  {CADENCE_LABELS[unit]}
                  {values.cadenceInterval === 1 ? "" : "s"}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="schedule-start">Starting</Label>
          <Input
            id="schedule-start"
            type="date"
            value={values.startDateString}
            disabled={startDateLocked}
            onChange={(e) => set("startDateString", e.target.value)}
          />
          {startDateLocked && (
            <p className="text-xs text-muted-foreground">
              Set when the schedule was created and kept as its billing anchor.
            </p>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="schedule-tz">Billing timezone</Label>
        <TimezoneSelect
          id="schedule-tz"
          value={values.timezone}
          onChange={(tz) => set("timezone", tz)}
          disabled={startDateLocked}
        />
        <p className="text-xs text-muted-foreground">
          &quot;The 1st&quot; means the 1st here, wherever the server runs.
        </p>
      </div>

      {firstRun && (
        <p className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
          First invoice on <strong>{firstRun}</strong>, then every{" "}
          {values.cadenceInterval === 1
            ? CADENCE_LABELS[values.cadenceUnit]
            : `${values.cadenceInterval} ${CADENCE_LABELS[values.cadenceUnit]}s`}
          .
        </p>
      )}

      <div className="space-y-2">
        <Label htmlFor="schedule-end">Ends</Label>
        <select
          id="schedule-end"
          className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          value={values.endMode}
          onChange={(e) =>
            set("endMode", e.target.value as RecurringInvoiceEndMode)
          }
        >
          <option value="never">Never — keep billing until I stop it</option>
          <option value="on_date">On a date</option>
          <option value="after_count">After a number of invoices</option>
        </select>
        {values.endMode === "on_date" && (
          <Input
            type="date"
            aria-label="End date"
            value={values.endDateString}
            onChange={(e) => set("endDateString", e.target.value)}
          />
        )}
        {values.endMode === "after_count" && (
          <Input
            type="number"
            min={1}
            aria-label="Number of invoices"
            value={values.maxCycles}
            onChange={(e) =>
              set("maxCycles", Math.max(1, Number(e.target.value) || 1))
            }
          />
        )}
      </div>

      <label className="flex items-start gap-3">
        <Checkbox
          checked={values.reviewFirst}
          onCheckedChange={(checked) => set("reviewFirst", checked === true)}
        />
        <span className="text-sm">
          Review each invoice before it goes out
          <span className="mt-0.5 block text-xs text-muted-foreground">
            Each cycle saves a draft and notifies you instead of emailing the
            customer. Off by default — the automation is the point.
          </span>
        </span>
      </label>

      <div className="space-y-2">
        <Label htmlFor="schedule-escalation">
          Raise a task after this many unpaid invoices
        </Label>
        <Input
          id="schedule-escalation"
          type="number"
          min={0}
          max={50}
          className="w-24"
          value={values.unpaidEscalationThreshold}
          onChange={(e) =>
            set(
              "unpaidEscalationThreshold",
              Math.max(0, Number(e.target.value) || 0),
            )
          }
        />
        <p className="text-xs text-muted-foreground">
          Unpaid cycles never stop the next invoice — the debt is real. This is
          how you find out. 0 turns the task off.
        </p>
      </div>
    </Card>
  );
}
