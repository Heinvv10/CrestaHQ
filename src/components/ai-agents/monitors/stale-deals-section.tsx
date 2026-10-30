"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, TimerOff } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { fetchPipelines } from "@/lib/pipelines/client";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  STALE_DEALS_MAX_THRESHOLD_DAYS,
  STALE_DEALS_MIN_THRESHOLD_DAYS,
  type StaleDealsConfigResponse,
  type WatchdogRunResponse,
} from "@/types/custom-agents";
import type { PipelineDoc } from "@/types/deals";

/**
 * Stale deals monitor config. Admins edit, members see a description. Rules
 * pick the deals (non-terminal stage past the threshold with no open task,
 * message or activity); the AI only writes the one-line next step. The
 * Monitors page renders it only while `agentsEnabledByAgency` is on (the
 * route 403s otherwise).
 */

const THRESHOLD_OPTIONS = [3, 5, 7, 10, 14, 21, 30, 60] as const;

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.round(ms / 60_000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function StaleDealsSection() {
  const { subAccountId, isAdmin } = useSubAccount();
  // Loaded here rather than from the context, whose list starts as a
  // synthesized default: filtering stage keys against that would wipe keys
  // for custom pipelines on save.
  const [pipelines, setPipelines] = useState<PipelineDoc[]>([]);
  const [pipelinesReady, setPipelinesReady] = useState(false);

  const [config, setConfig] = useState<StaleDealsConfigResponse | null>(null);
  const [runs, setRuns] = useState<WatchdogRunResponse[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  const [enabled, setEnabled] = useState(false);
  const [thresholdDays, setThresholdDays] = useState(7);
  // Empty = every pipeline.
  const [pipelineIds, setPipelineIds] = useState<string[]>([]);
  const [excludeStageKeys, setExcludeStageKeys] = useState<string[]>([]);
  const [instructions, setInstructions] = useState("");
  const [quietOn, setQuietOn] = useState(false);
  const [quietStart, setQuietStart] = useState(21);
  const [quietEnd, setQuietEnd] = useState(7);
  const [quietTz, setQuietTz] = useState("UTC");

  const hydrate = useCallback(async () => {
    fetchPipelines(subAccountId)
      .then((list) => {
        setPipelines(list);
        setPipelinesReady(true);
      })
      .catch(() => {
        // Filters stay hidden and saved stage keys are sent back untouched.
        toast.error("Couldn't load pipelines for the stale deals filters.");
      });
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/agents/stale-deals`,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        config?: StaleDealsConfigResponse;
        runs?: WatchdogRunResponse[];
      };
      if (data.config) {
        setConfig(data.config);
        setEnabled(data.config.enabled);
        setThresholdDays(data.config.thresholdDays);
        setPipelineIds(data.config.pipelineIds ?? []);
        setExcludeStageKeys(data.config.excludeStageKeys ?? []);
        setInstructions(data.config.instructions ?? "");
        setQuietOn(data.config.quietHours !== null);
        if (data.config.quietHours) {
          setQuietStart(data.config.quietHours.startHour);
          setQuietEnd(data.config.quietHours.endHour);
          setQuietTz(data.config.quietHours.timezone);
        } else {
          setQuietTz(
            Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
          );
        }
      }
      setRuns(data.runs ?? []);
    } catch {
      toast.error("Couldn't load the stale deals monitor config.");
    } finally {
      setLoaded(true);
    }
  }, [subAccountId]);

  useEffect(() => {
    if (!isAdmin) {
      setLoaded(true);
      return;
    }
    void hydrate();
  }, [isAdmin, hydrate]);

  // Stage picks only make sense for pipelines that are in scope.
  const stageChoices = useMemo(
    () =>
      pipelines
        .filter((p) => pipelineIds.length === 0 || pipelineIds.includes(p.id))
        .flatMap((p) =>
          p.stages
            .filter((s) => !s.terminal)
            .map((s) => ({
              key: `${p.id}:${s.id}`,
              label: pipelines.length > 1 ? `${p.name} · ${s.label}` : s.label,
            })),
        ),
    [pipelines, pipelineIds],
  );

  const togglePipeline = (id: string) =>
    setPipelineIds((cur) =>
      cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id],
    );
  const toggleStage = (key: string) =>
    setExcludeStageKeys((cur) =>
      cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key],
    );

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/agents/stale-deals`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            enabled,
            thresholdDays,
            pipelineIds: pipelineIds.length > 0 ? pipelineIds : null,
            // Drop stale keys for pipelines that left the scope. Before the
            // pipelines load only the default is known, so filtering then
            // would wipe keys for custom pipelines.
            excludeStageKeys: pipelinesReady
              ? excludeStageKeys.filter((k) =>
                  stageChoices.some((c) => c.key === k),
                )
              : excludeStageKeys,
            instructions: instructions.trim() || null,
            quietHours: quietOn
              ? { startHour: quietStart, endHour: quietEnd, timezone: quietTz }
              : null,
          }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        config?: StaleDealsConfigResponse;
      };
      if (!res.ok) throw new Error(data.error ?? "Failed to save.");
      if (data.config) {
        setConfig(data.config);
        setExcludeStageKeys(data.config.excludeStageKeys ?? []);
      }
      toast.success(
        enabled
          ? "Stale deals monitor enabled — it checks the pipeline every hour."
          : "Stale deals monitor settings saved.",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  const lastRun = runs[0] ?? null;

  return (
    <div className="rounded-2xl border bg-card p-6" data-testid="monitor-stale-deals">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
          <TimerOff className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">Stale deals</h2>
            <span
              className={
                "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider " +
                (config?.enabled
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "border text-muted-foreground")
              }
            >
              {config?.enabled ? "Active" : "Off"}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Checks the pipeline every hour for deals that have sat in one stage
            past your threshold with no open task, no message either way and no
            activity. Each one gets a follow-up task with a suggested next step
            and a push to the team. It never messages your customers and never
            moves a deal.
          </p>
        </div>
      </div>

      {!isAdmin ? (
        <p className="mt-4 text-sm text-muted-foreground">
          A workspace admin can configure this monitor.
        </p>
      ) : !loaded ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </p>
      ) : (
        <div className="mt-5 space-y-4">
          <label className="flex cursor-pointer items-start gap-2.5">
            <Checkbox
              checked={enabled}
              onCheckedChange={(v) => setEnabled(v === true)}
              disabled={saving}
              className="mt-0.5"
            />
            <span>
              <span className="text-sm font-medium">Enable the stale deals monitor</span>
              <span className="block text-xs text-muted-foreground">
                Runs hourly. Worst case it&apos;s wrong: an unnecessary task —
                it can&apos;t touch customers or deals.
              </span>
            </span>
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label className="mb-1 block text-xs font-medium text-muted-foreground">
                Flag deals in one stage for
              </Label>
              <select
                value={thresholdDays}
                onChange={(e) => setThresholdDays(Number(e.target.value))}
                disabled={saving}
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 [&_option]:bg-background [&_option]:text-foreground"
              >
                {/* The assistant can set any day count, so keep the saved value selectable. */}
                {[...new Set<number>([...THRESHOLD_OPTIONS, thresholdDays])]
                  .filter(
                    (d) =>
                      d >= STALE_DEALS_MIN_THRESHOLD_DAYS &&
                      d <= STALE_DEALS_MAX_THRESHOLD_DAYS,
                  )
                  .sort((a, b) => a - b)
                  .map((d) => (
                  <option key={d} value={d}>
                    {d} days+
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label className="mb-1 block text-xs font-medium text-muted-foreground">
                Quiet hours (push suppressed; tasks still created)
              </Label>
              <div className="flex items-center gap-2">
                <Checkbox
                  checked={quietOn}
                  onCheckedChange={(v) => setQuietOn(v === true)}
                  disabled={saving}
                />
                <select
                  value={quietStart}
                  onChange={(e) => setQuietStart(Number(e.target.value))}
                  disabled={saving || !quietOn}
                  className="h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none disabled:opacity-60 [&_option]:bg-background [&_option]:text-foreground"
                >
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>
                      {h}:00
                    </option>
                  ))}
                </select>
                <span className="text-xs text-muted-foreground">to</span>
                <select
                  value={quietEnd}
                  onChange={(e) => setQuietEnd(Number(e.target.value))}
                  disabled={saving || !quietOn}
                  className="h-9 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs outline-none disabled:opacity-60 [&_option]:bg-background [&_option]:text-foreground"
                >
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>
                      {h}:00
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {pipelinesReady && pipelines.length > 1 && (
            <div>
              <Label className="mb-1 block text-xs font-medium text-muted-foreground">
                Pipelines to watch (none ticked = all)
              </Label>
              <div className="flex flex-wrap gap-3">
                {pipelines.map((p) => (
                  <label
                    key={p.id}
                    className="flex cursor-pointer items-center gap-1.5 text-sm"
                  >
                    <Checkbox
                      checked={pipelineIds.includes(p.id)}
                      onCheckedChange={() => togglePipeline(p.id)}
                      disabled={saving}
                    />
                    {p.name}
                  </label>
                ))}
              </div>
            </div>
          )}

          {pipelinesReady && stageChoices.length > 0 && (
            <div>
              <Label className="mb-1 block text-xs font-medium text-muted-foreground">
                Stages to ignore (e.g. a parked or waiting stage)
              </Label>
              <div className="flex flex-wrap gap-3">
                {stageChoices.map((c) => (
                  <label
                    key={c.key}
                    className="flex cursor-pointer items-center gap-1.5 text-sm"
                  >
                    <Checkbox
                      checked={excludeStageKeys.includes(c.key)}
                      onCheckedChange={() => toggleStage(c.key)}
                      disabled={saving}
                    />
                    {c.label}
                  </label>
                ))}
              </div>
            </div>
          )}

          <div>
            <Label className="mb-1 block text-xs font-medium text-muted-foreground">
              Guidance for the suggested next step (optional)
            </Label>
            <Textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="e.g. Always suggest a phone call before a third email. Mention our 10% end-of-month offer."
              maxLength={1000}
              rows={2}
              disabled={saving}
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] text-muted-foreground">
              {lastRun
                ? `Last run ${relativeTime(lastRun.startedAt)} — ${
                    lastRun.status === "completed"
                      ? `${lastRun.scanned} past threshold, ${lastRun.flagged} flagged`
                      : lastRun.status === "skipped"
                        ? `skipped (${lastRun.skippedReason ?? "—"})`
                        : "failed"
                  }`
                : "No runs yet — the first sweep lands within the hour after enabling."}
            </p>
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? (
                <>
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  Saving…
                </>
              ) : (
                "Save"
              )}
            </Button>
          </div>

          {runs.length > 0 && (
            <div className="border-t pt-3">
              <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Recent runs
              </p>
              <ul className="space-y-1">
                {runs.map((r) => (
                  <li
                    key={r.id}
                    className="flex items-center gap-2 text-xs text-muted-foreground"
                  >
                    <span className="w-16 shrink-0 tabular-nums">
                      {relativeTime(r.startedAt)}
                    </span>
                    <span
                      className={
                        "rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase " +
                        (r.status === "completed"
                          ? r.flagged > 0
                            ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                            : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                          : r.status === "skipped"
                            ? "bg-muted"
                            : "bg-destructive/10 text-destructive")
                      }
                    >
                      {r.status === "completed"
                        ? r.flagged > 0
                          ? `${r.flagged} flagged`
                          : "all clear"
                        : r.status}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {r.status === "completed"
                        ? r.actions.length > 0
                          ? r.actions
                              .map((a) => `${a.dealTitle ?? a.contactName}: ${a.reason}`)
                              .join(" · ")
                          : `${r.scanned} past threshold, none needed a nudge`
                        : (r.skippedReason ?? "")}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
