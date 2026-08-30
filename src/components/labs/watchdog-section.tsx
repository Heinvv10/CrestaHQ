"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { AlarmClockCheck, Loader2 } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type {
  WatchdogConfigResponse,
  WatchdogRunResponse,
} from "@/types/custom-agents";

/**
 * Inbox Follow-up Watchdog config card (Labs). Admin-configurable; members
 * see a read-only description. The Labs PAGE gates on labsEnabledByAgency —
 * this card additionally surfaces the AI Suite gate requirement (the
 * watchdog spends agency AI credits) without duplicating the page gate.
 */

const THRESHOLD_OPTIONS = [1, 2, 3, 6, 12, 24] as const;

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

export function WatchdogSection() {
  const { subAccountId, subAccount, isAdmin } = useSubAccount();

  const [config, setConfig] = useState<WatchdogConfigResponse | null>(null);
  const [runs, setRuns] = useState<WatchdogRunResponse[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  const [enabled, setEnabled] = useState(false);
  const [thresholdHours, setThresholdHours] = useState(3);
  const [instructions, setInstructions] = useState("");
  const [quietOn, setQuietOn] = useState(false);
  const [quietStart, setQuietStart] = useState(21);
  const [quietEnd, setQuietEnd] = useState(7);
  const [quietTz, setQuietTz] = useState("UTC");

  const aiGateOn = subAccount?.aiSuiteEnabledByAgency === true;

  const hydrate = useCallback(async () => {
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/agents/watchdog`);
      const data = (await res.json()) as {
        config?: WatchdogConfigResponse;
        runs?: WatchdogRunResponse[];
      };
      if (data.config) {
        setConfig(data.config);
        setEnabled(data.config.enabled);
        setThresholdHours(data.config.thresholdHours);
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
      toast.error("Couldn't load the watchdog config.");
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

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/agents/watchdog`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            enabled,
            thresholdHours,
            instructions: instructions.trim() || null,
            quietHours: quietOn
              ? { startHour: quietStart, endHour: quietEnd, timezone: quietTz }
              : null,
          }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        config?: WatchdogConfigResponse;
      };
      if (!res.ok) throw new Error(data.error ?? "Failed to save.");
      if (data.config) setConfig(data.config);
      toast.success(
        enabled
          ? "Watchdog enabled — it checks the inbox every hour."
          : "Watchdog settings saved.",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  const lastRun = runs[0] ?? null;

  return (
    <div className="rounded-2xl border bg-card p-6">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
          <AlarmClockCheck className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold">Inbox Follow-up Watchdog</h2>
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
            Checks your unified inbox every hour, spots inbound conversations
            that have gone unanswered too long, and judges which ones genuinely
            need a human — then creates a follow-up task and sends a push
            notification with the reason. It never messages your customers and
            never changes your data.
          </p>
        </div>
      </div>

      {!isAdmin ? (
        <p className="mt-4 text-sm text-muted-foreground">
          A workspace admin can configure this agent.
        </p>
      ) : !loaded ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
        </p>
      ) : (
        <div className="mt-5 space-y-4">
          {!aiGateOn && (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              The watchdog needs the <strong>AI Suite</strong> enabled for this
              workspace (it spends your agency&apos;s AI credits). Ask your
              agency owner to enable it from the Manage panel before switching
              the watchdog on.
            </p>
          )}

          <label className="flex cursor-pointer items-start gap-2.5">
            <Checkbox
              checked={enabled}
              onCheckedChange={(v) => setEnabled(v === true)}
              disabled={saving || (!aiGateOn && !enabled)}
              className="mt-0.5"
            />
            <span>
              <span className="text-sm font-medium">Enable the watchdog</span>
              <span className="block text-xs text-muted-foreground">
                Runs hourly. Worst case it&apos;s wrong: an unnecessary task —
                it can&apos;t touch customers or data.
              </span>
            </span>
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label className="mb-1 block text-xs font-medium text-muted-foreground">
                Flag conversations unanswered for
              </Label>
              <select
                value={thresholdHours}
                onChange={(e) => setThresholdHours(Number(e.target.value))}
                disabled={saving}
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 [&_option]:bg-background [&_option]:text-foreground"
              >
                {THRESHOLD_OPTIONS.map((h) => (
                  <option key={h} value={h}>
                    {h} hour{h === 1 ? "" : "s"}+
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

          <div>
            <Label className="mb-1 block text-xs font-medium text-muted-foreground">
              Extra criteria for the judge (optional)
            </Label>
            <Textarea
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="e.g. Prioritise anything mentioning price, cancellation, or a complaint. Ignore delivery notifications."
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
                      ? `${lastRun.scanned} scanned, ${lastRun.judged} judged, ${lastRun.flagged} flagged`
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
                              .map((a) => `${a.contactName}: ${a.reason}`)
                              .join(" · ")
                          : `${r.scanned} scanned, ${r.judged} judged`
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
