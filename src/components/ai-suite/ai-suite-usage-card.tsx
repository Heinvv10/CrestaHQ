"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { AiSuiteLevel } from "@/types/ai-suite";

interface UsageDay {
  date: string;
  messages: number;
  actions: number;
}

// Static class strings so Tailwind's JIT picks them up. Index = intensity.
// Cornflower-blue ramp matching Claude's activity heatmap; index 0 = no
// activity (a faint theme-neutral cell that reads on light + dark).
const CELL_CLASS = [
  "bg-muted",
  "bg-[#3b4a78]",
  "bg-[#4c66a6]",
  "bg-[#5f83cf]",
  "bg-[#77a0e3]",
];

function intensity(total: number): number {
  if (total <= 0) return 0;
  if (total <= 2) return 1;
  if (total <= 5) return 2;
  if (total <= 10) return 3;
  return 4;
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Day of week (0 = Sun … 6 = Sat) for a UTC `YYYY-MM-DD` string. */
function utcDayOfWeek(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * Claude-style activity heatmap for the AI Suite: a 7-row (one row per weekday)
 * contribution grid with weeks as tightly-packed columns, colored by combined
 * messages + actions. No header or stat line — just the grid, left-aligned in a
 * card that grows with the grid. Reads year-to-date from /api/ai-suite/usage
 * (starts at the week of Jan 1 and grows each week); renders nothing while
 * loading or on error so it stays unobtrusive.
 */
export function AiSuiteUsageCard({
  level,
  subAccountId,
}: {
  level: AiSuiteLevel;
  subAccountId?: string;
}) {
  const [days, setDays] = useState<UsageDay[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ level });
    if (subAccountId) params.set("subAccountId", subAccountId);
    fetch(`/api/ai-suite/usage?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed"))))
      .then((d: { days?: UsageDay[] }) => {
        if (!cancelled) setDays(d.days ?? []);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [level, subAccountId]);

  if (failed || !days || days.length === 0) return null;

  // Pad the front with blank cells so the first day lands in its correct
  // weekday row, pad the tail so the final week is complete, then slice into
  // week columns (7 cells each, Sun→Sat top→bottom).
  const leadingBlanks = utcDayOfWeek(days[0].date);
  const cells: (UsageDay | null)[] = [
    ...Array.from({ length: leadingBlanks }, () => null),
    ...days,
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (UsageDay | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  return (
    <div className="w-fit max-w-full shrink-0 rounded-xl border bg-card p-3">
      <div className="flex justify-start gap-[3px] overflow-x-auto">
        {weeks.map((week, wi) => (
          <div key={wi} className="flex flex-col gap-[3px]">
            {week.map((d, di) => {
              if (!d) return <div key={di} className="h-[11px] w-[11px]" />;
              const total = d.messages + d.actions;
              return (
                <div
                  key={d.date}
                  title={`${fmtDate(d.date)} — ${plural(d.messages, "message")}, ${plural(
                    d.actions,
                    "action",
                  )}`}
                  className={cn(
                    "h-[11px] w-[11px] rounded-[2px]",
                    CELL_CLASS[intensity(total)],
                  )}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
