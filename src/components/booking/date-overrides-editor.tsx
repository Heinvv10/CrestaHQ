"use client";

import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  hhmmToMinutes,
  minutesToHHMM,
} from "@/components/booking/working-hours-grid";
import type { DateOverride } from "@/types/booking";

/**
 * "Date-specific hours": per-date ranges that replace the weekly hours for
 * that date only, or mark it unavailable. Used for the page and per host
 * (a host's entry beats the page's for the same date). Dates and times are
 * in the page's timezone.
 */

const TIME_CLASS =
  "h-8 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";
const DEFAULT_RANGE = { startMinute: 9 * 60, endMinute: 17 * 60 };

/** The first date from today (in the page's timezone) not already listed. */
function nextFreeDate(taken: Set<string>, timezone: string): string {
  // en-CA formats as YYYY-MM-DD.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  for (;;) {
    const key = d.toISOString().slice(0, 10);
    if (!taken.has(key)) return key;
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

export function DateOverridesEditor({
  value,
  onChange,
  timezone,
  disabled,
  label = "Date-specific hours",
  hint = "Change the hours for one date, or mark it unavailable. Replaces the weekly hours for that date only.",
}: {
  value: DateOverride[];
  onChange: (next: DateOverride[]) => void;
  /** The page's timezone — "Add date" starts from today there. */
  timezone: string;
  disabled?: boolean;
  label?: string;
  hint?: string;
}) {
  // Rows keep their position (keyed by index) while being edited — no
  // re-sort, so typing a date never remounts the row. The server sorts.
  const [collision, setCollision] = useState<number | null>(null);

  function update(i: number, next: DateOverride) {
    onChange(value.map((o, n) => (n === i ? next : o)));
  }

  return (
    <div className="space-y-2" role="group" aria-label={label}>
      <p className="text-sm font-medium">{label}</p>
      <p className="text-[11px] text-muted-foreground">{hint}</p>
      {value.map((o, i) => (
        <div
          key={i}
          data-testid="date-override"
          className="space-y-1.5 rounded-lg border bg-background px-3 py-2"
        >
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="date"
              aria-label="Date"
              value={o.date}
              onChange={(e) => {
                const date = e.target.value;
                if (!date) return;
                if (value.some((x, n) => n !== i && x.date === date)) {
                  setCollision(i);
                  return;
                }
                setCollision(null);
                update(i, { ...o, date });
              }}
              disabled={disabled}
              className={TIME_CLASS}
            />
            <label className="flex items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={o.ranges.length === 0}
                onChange={(e) =>
                  update(i, { ...o, ranges: e.target.checked ? [] : [DEFAULT_RANGE] })
                }
                disabled={disabled}
                className="h-3.5 w-3.5"
              />
              Unavailable all day
            </label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setCollision(null);
                onChange(value.filter((_, n) => n !== i));
              }}
              disabled={disabled}
              aria-label={`Remove ${o.date}`}
              className="ml-auto text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
          {collision === i && (
            <p role="alert" className="text-[11px] text-destructive">
              That date is already listed — edit its row instead.
            </p>
          )}
          {o.ranges.map((r, ri) => (
            <div key={ri} className="flex items-center gap-1.5">
              {(["startMinute", "endMinute"] as const).map((k, j) => (
                <span key={k} className="flex items-center gap-1.5">
                  {j === 1 && <span className="text-xs text-muted-foreground">to</span>}
                  <input
                    type="time"
                    aria-label={k === "startMinute" ? "From" : "To"}
                    value={minutesToHHMM(r[k])}
                    onChange={(e) => {
                      const m = hhmmToMinutes(e.target.value);
                      if (m === null) return;
                      const ranges = o.ranges.map((x, n) => (n === ri ? { ...x, [k]: m } : x));
                      update(i, { ...o, ranges });
                    }}
                    disabled={disabled}
                    className={TIME_CLASS}
                  />
                </span>
              ))}
              {o.ranges.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    update(i, { ...o, ranges: o.ranges.filter((_, n) => n !== ri) })
                  }
                  disabled={disabled}
                  aria-label="Remove this range"
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          ))}
          {o.ranges.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                // The new range starts where the latest one ends.
                const start = Math.max(...o.ranges.map((x) => x.endMinute));
                update(i, {
                  ...o,
                  ranges: [...o.ranges, { startMinute: start, endMinute: Math.min(start + 60, 1440) }],
                });
              }}
              disabled={disabled || Math.max(...o.ranges.map((x) => x.endMinute)) >= 1440}
              className="h-7 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <Plus className="mr-1 h-3 w-3" />
              Add another range
            </Button>
          )}
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          onChange([
            ...value,
            {
              date: nextFreeDate(new Set(value.map((o) => o.date)), timezone),
              ranges: [DEFAULT_RANGE],
            },
          ])
        }
        disabled={disabled}
      >
        <Plus className="mr-1 h-3.5 w-3.5" />
        Add date
      </Button>
    </div>
  );
}
