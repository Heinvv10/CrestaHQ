"use client";

import { useEffect, useState } from "react";
import { History } from "lucide-react";
import type { PipelineDoc } from "@/types/deals";
import type { StageHistoryReport as Report } from "@/lib/reports/stage-history";

type Body = Report & { rowsRead: number; truncated: boolean };
type Load = { state: "loading" } | { state: "error" } | { state: "ready"; body: Body };

const DAY = 86_400_000;

function duration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < DAY) return `${Math.max(1, Math.round(ms / 3_600_000))}h`;
  return `${(ms / DAY).toFixed(1)}d`;
}

/**
 * Stages tab: median time-in-stage, stage-to-stage conversion and velocity
 * for one pipeline over the page's date range, from the stage history the
 * server reads (live rows only, import timing excluded, territory-scoped).
 * Definitions: docs/programme/w3-stage-history.md "Report definitions".
 */
export function StageHistoryReport({
  subAccountId,
  pipelines,
  rangeDays,
}: {
  subAccountId: string;
  pipelines: PipelineDoc[];
  rangeDays: number | null;
}) {
  const [pipelineId, setPipelineId] = useState(
    () => (pipelines.find((p) => p.isDefault) ?? pipelines[0])?.id ?? "default",
  );
  const [load, setLoad] = useState<Load>({ state: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    const to = Date.now();
    const from = rangeDays ? to - rangeDays * DAY : 0;
    const q = new URLSearchParams({ pipelineId, from: String(from), to: String(to) });
    setLoad({ state: "loading" });
    fetch(`/api/sub-accounts/${subAccountId}/reports/stage-history?${q}`, { signal: controller.signal })
      .then(async (res) => {
        const body = (await res.json()) as Body;
        if (!res.ok || !Array.isArray(body.stages)) throw new Error("stage_history_load_failed");
        setLoad({ state: "ready", body });
      })
      .catch(() => !controller.signal.aborted && setLoad({ state: "error" }));
    return () => controller.abort();
  }, [subAccountId, pipelineId, rangeDays]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          Recorded from when stage tracking went live. Earlier moves are not included, so an older
          range reads as empty or partial.
        </p>
        {pipelines.length > 1 && (
          <select
            value={pipelineId}
            onChange={(e) => setPipelineId(e.target.value)}
            className="h-8 rounded-lg border bg-background px-2 text-sm"
            aria-label="Pipeline"
          >
            {pipelines.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {load.state === "loading" ? (
        <div className="h-72 animate-pulse rounded-2xl bg-muted/30" />
      ) : load.state === "error" ? (
        <Empty text="Couldn't load stage history. Try again in a moment." />
      ) : load.body.rowsRead === 0 ? (
        <Empty text="No stage moves recorded in this range yet. Moves are tracked from when stage history went live; there is no backfill of older deals." />
      ) : (
        <Ready body={load.body} />
      )}
    </div>
  );
}

function Ready({ body }: { body: Body }) {
  const { stages, velocity } = body;
  const funnel = stages.filter((s) => s.terminal !== "lost");
  return (
    <>
      {body.truncated && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          This range has more stage moves than one report reads, so the numbers cover the earliest
          of them. Pick a shorter range for complete figures.
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Tile label="Won in range" value={String(velocity.won)} hint="Distinct deals" />
        <Tile
          label="Median time to win"
          value={duration(velocity.medianMs)}
          hint={`Created → won · ${velocity.withCreation} of ${velocity.won} deals have a recorded creation`}
        />
        <Tile
          label="Stays measured"
          value={String(stages.reduce((s, x) => s + x.completedStays, 0))}
          hint="Stage exits in range"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-2xl border bg-card p-5">
          <h2 className="text-sm font-semibold">Median time in stage</h2>
          <p className="mb-4 text-xs text-muted-foreground">
            Stays that ended in range · deals still in a stage are counted separately
          </p>
          <HBars
            rows={stages.map((s) => ({
              label: s.label,
              value: s.medianMs ?? 0,
              text: `${duration(s.medianMs)} · ${s.completedStays} stay${s.completedStays === 1 ? "" : "s"} · ${s.stillIn} still in`,
            }))}
          />
        </section>

        <section className="rounded-2xl border bg-card p-5">
          <h2 className="text-sm font-semibold">Stage conversion</h2>
          <p className="mb-4 text-xs text-muted-foreground">
            Of deals entering a stage in range, how many later reached a stage further along
          </p>
          <HBars
            rows={funnel
              .filter((s) => s.advanced !== null)
              .map((s) => ({
                label: s.label,
                value: s.entered ? (s.advanced as number) / s.entered : 0,
                text: s.entered
                  ? `${Math.round(((s.advanced as number) / s.entered) * 100)}% · ${s.advanced} of ${s.entered}`
                  : "no entries",
              }))}
            max={1}
          />
        </section>
      </div>
    </>
  );
}

/** Horizontal bars: HTML labels (readable at phone width), each bar an inline SVG. */
function HBars({ rows, max }: { rows: { label: string; value: number; text: string }[]; max?: number }) {
  const top = Math.max(max ?? 0, ...rows.map((r) => r.value), 1e-9);
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.label}>
          <div className="mb-1 flex items-center justify-between gap-2 text-xs">
            <span className="truncate font-medium">{r.label}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{r.text}</span>
          </div>
          <svg viewBox="0 0 100 8" preserveAspectRatio="none" className="h-2 w-full" aria-hidden>
            <rect x={0} y={0} width={100} height={8} rx={4} className="fill-muted" />
            <rect x={0} y={0} width={(r.value / top) * 100} height={8} rx={4} className="fill-indigo-500" />
          </svg>
        </div>
      ))}
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-2xl border bg-card p-4">
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
        <History className="h-4 w-4" />
      </span>
      <p className="mt-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-2xl font-semibold tracking-tight">{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="flex h-32 items-center justify-center rounded-lg border border-dashed px-6 text-center text-xs text-muted-foreground">
      {text}
    </div>
  );
}
