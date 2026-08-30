"use client";

import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Loader2, MailQuestion, PauseCircle } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Sending preferences — the per-workspace outbound-email + workflow-engine
 * settings that used to live on the legacy Automations → Settings page
 * (deleted in the Workflow Builder v1 clean-slate replace, which orphaned
 * them; see the user report of 2026-07-07):
 *
 *   - `replyToEmail` — Reply-To header on every automated/broadcast email
 *   - `sendWindow`   — quiet-hours restriction for workflow sends
 *   - `automationsPaused` — the workflow-engine kill switch (still enforced
 *     by lib/workflows/engine.ts, so legacy paused workspaces need this UI
 *     to un-pause)
 *
 * All three PATCH the existing /api/agency/sub-accounts/[id] route
 * (sub-account-admin gated) — no new backend. Admin-only card, mirrors the
 * other settings sections.
 */

const HOURS = Array.from({ length: 25 }, (_, i) => i);

function hourLabel(h: number): string {
  if (h === 0) return "12:00 AM";
  if (h === 24) return "12:00 AM (end of day)";
  if (h === 12) return "12:00 PM";
  return h < 12 ? `${h}:00 AM` : `${h - 12}:00 PM`;
}

const SELECT_CLASS =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 [&_option]:bg-background [&_option]:text-foreground";

export function SubAccountSendingPreferencesSection() {
  const { subAccountId, subAccount, isAdmin } = useSubAccount();

  const [replyTo, setReplyTo] = useState("");
  const [windowEnabled, setWindowEnabled] = useState(false);
  const [startHour, setStartHour] = useState(8);
  const [endHour, setEndHour] = useState(20);
  const [timezone, setTimezone] = useState("");
  const [saving, setSaving] = useState(false);
  const [togglingPause, setTogglingPause] = useState(false);

  // Sync from the live doc (onSnapshot via the provider) whenever the
  // workspace changes — but not on every keystroke-triggered re-render.
  useEffect(() => {
    setReplyTo(subAccount?.replyToEmail ?? "");
    const w = subAccount?.sendWindow ?? null;
    setWindowEnabled(!!w);
    setStartHour(w?.startHour ?? 8);
    setEndHour(w?.endHour ?? 20);
    setTimezone(w?.timezone ?? subAccount?.timezone ?? "UTC");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subAccountId, subAccount?.updatedAt]);

  if (!isAdmin) return null;

  const paused = subAccount?.automationsPaused === true;

  async function patch(body: Record<string, unknown>): Promise<void> {
    const res = await fetch(`/api/agency/sub-accounts/${subAccountId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(data.error ?? "Failed to save.");
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    if (windowEnabled && startHour >= endHour) {
      toast.error("The send window must start before it ends.");
      return;
    }
    setSaving(true);
    try {
      await patch({
        replyToEmail: replyTo.trim() || null,
        sendWindow: windowEnabled
          ? { startHour, endHour, timezone: timezone.trim() || "UTC" }
          : null,
      });
      toast.success("Sending preferences saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save.");
    } finally {
      setSaving(false);
    }
  }

  async function handleTogglePause() {
    setTogglingPause(true);
    try {
      await patch({ automationsPaused: !paused });
      toast.success(
        paused
          ? "Workflows resumed — new triggers fire again."
          : "All workflows paused — nothing will fire until you resume.",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update.");
    } finally {
      setTogglingPause(false);
    }
  }

  return (
    <section className="rounded-2xl border bg-card p-6">
      <header className="mb-4 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600 dark:text-violet-400">
          <MailQuestion className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-semibold">Sending preferences</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Where replies land, when automated messages may send, and the
            master pause for workflows.
          </p>
        </div>
      </header>

      <form onSubmit={handleSave} className="space-y-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Reply-To email
          </label>
          <Input
            type="email"
            value={replyTo}
            onChange={(e) => setReplyTo(e.target.value)}
            placeholder="you@yourbusiness.com"
            disabled={saving}
            className="max-w-md"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Replies to every automated and broadcast email come back to this
            address. Required before sending from a dedicated domain — the
            domain has no inbox, so replies bounce without it.
          </p>
        </div>

        <div className="rounded-lg border p-3">
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={windowEnabled}
              onChange={(e) => setWindowEnabled(e.target.checked)}
              disabled={saving}
              className="mt-0.5 h-4 w-4 cursor-pointer"
            />
            <span>
              <span className="font-medium">Restrict sending hours</span>
              <span className="block text-xs text-muted-foreground">
                Workflow messages outside the window wait for the next window
                start instead of sending at 3 AM.
              </span>
            </span>
          </label>
          {windowEnabled && (
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
                  From
                </label>
                <select
                  value={startHour}
                  onChange={(e) => setStartHour(Number(e.target.value))}
                  disabled={saving}
                  className={SELECT_CLASS}
                >
                  {HOURS.filter((h) => h < 24).map((h) => (
                    <option key={h} value={h}>
                      {hourLabel(h)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
                  Until
                </label>
                <select
                  value={endHour}
                  onChange={(e) => setEndHour(Number(e.target.value))}
                  disabled={saving}
                  className={SELECT_CLASS}
                >
                  {HOURS.filter((h) => h > 0).map((h) => (
                    <option key={h} value={h}>
                      {hourLabel(h)}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
                  Timezone (IANA)
                </label>
                <Input
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  placeholder="Australia/Sydney"
                  disabled={saving}
                  className="h-9"
                />
              </div>
            </div>
          )}
        </div>

        <Button type="submit" size="sm" disabled={saving}>
          {saving ? (
            <>
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              Saving…
            </>
          ) : (
            "Save sending preferences"
          )}
        </Button>
      </form>

      <div
        className={`mt-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 ${
          paused ? "border-amber-500/40 bg-amber-500/5" : ""
        }`}
      >
        <div className="flex items-start gap-2 text-sm">
          <PauseCircle
            className={`mt-0.5 h-4 w-4 shrink-0 ${
              paused
                ? "text-amber-600 dark:text-amber-400"
                : "text-muted-foreground"
            }`}
          />
          <span>
            <span className="font-medium">
              {paused ? "All workflows are paused" : "Pause all workflows"}
            </span>
            <span className="block text-xs text-muted-foreground">
              {paused
                ? "No triggers fire and in-flight runs stop at their next step until you resume."
                : "Emergency stop: prevents every workflow from firing or continuing."}
            </span>
          </span>
        </div>
        <Button
          type="button"
          size="sm"
          variant={paused ? "default" : "outline"}
          onClick={handleTogglePause}
          disabled={togglingPause}
        >
          {togglingPause ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : null}
          {paused ? "Resume workflows" : "Pause workflows"}
        </Button>
      </div>
    </section>
  );
}
