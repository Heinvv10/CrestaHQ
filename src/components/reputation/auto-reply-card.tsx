"use client";

import { useEffect, useState } from "react";
import { Loader2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Reputation → Settings: the "Auto-reply" card (AUTO_REPLY_V1_PLAN.md, UI) —
 * master switch, Auto / Approval per star, the backlog option, and the daily
 * caps read-only (the server's constants, via GET). Every save sends the whole
 * `{enabled, modes, includeBacklog}` the route allow-lists.
 *
 * Hidden until PR 2 ships the engine: `AUTO_REPLY_UI_ENABLED` keeps the
 * settings page from mounting it.
 */
export const AUTO_REPLY_UI_ENABLED = false;

type Mode = "auto" | "approval";
type Modes = Record<"1" | "2" | "3" | "4" | "5", Mode>;
interface Settings {
  enabled: boolean;
  modes: Modes;
  includeBacklog: boolean;
}
type Load =
  | { state: "loading" }
  | { state: "error" }
  | { state: "ready"; gatesOn: boolean; available: boolean; dailyPostCap: number; dailyDraftCap: number };

const STARS = ["1", "2", "3", "4", "5"] as const;

export function AutoReplyCard({ subAccountId, isAdmin }: { subAccountId: string; isAdmin: boolean }) {
  const api = `/api/sub-accounts/${subAccountId}/reputation/auto-reply`;
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const res = await fetch(api, { signal: controller.signal }).catch(() => null);
      const data = (await res?.json().catch(() => null)) as
        | (Settings & { gatesOn?: boolean; available?: boolean; dailyPostCap?: number; dailyDraftCap?: number })
        | null;
      if (controller.signal.aborted) return;
      if (!res?.ok || !data || typeof data.enabled !== "boolean" || !data.modes) return setLoad({ state: "error" });
      setSettings({ enabled: data.enabled, modes: data.modes, includeBacklog: data.includeBacklog === true });
      setLoad({
        state: "ready", gatesOn: data.gatesOn === true, available: data.available === true,
        dailyPostCap: Number(data.dailyPostCap), dailyDraftCap: Number(data.dailyDraftCap),
      });
    })();
    return () => controller.abort();
  }, [api]);

  const change = (patch: Partial<Settings>) => {
    setSettings((s) => (s ? { ...s, ...patch } : s));
    setSaved(false);
  };

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    const res = await fetch(api, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(settings) }).catch(() => null);
    const data = (await res?.json().catch(() => null)) as { error?: string; reviewsAutoReply?: Settings } | null;
    setSaving(false);
    if (res?.ok && data?.reviewsAutoReply) {
      const r = data.reviewsAutoReply;
      setSettings({ enabled: r.enabled, modes: r.modes, includeBacklog: r.includeBacklog });
      setSaved(true);
    } else {
      setError(data?.error ?? "The auto-reply settings could not be saved. Please try again.");
    }
  };

  const readOnly = !isAdmin || saving;

  return (
    <section className="rounded-2xl border bg-card p-6" data-testid="rep-settings-autoreply-card">
      <h2 className="text-base font-semibold">Auto-reply</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Choose, per star rating, whether the AI posts its reply to Google by itself (Auto) or a person posts its draft (Approval).
      </p>

      {load.state === "loading" && (
        <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground" data-testid="rep-settings-autoreply-loading">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </p>
      )}
      {load.state === "error" && (
        <p className="mt-3 text-sm text-destructive" data-testid="rep-settings-autoreply-error">The auto-reply settings could not be loaded.</p>
      )}
      {load.state === "ready" && !load.gatesOn && (
        <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground" data-testid="rep-settings-autoreply-locked">
          <Lock className="h-4 w-4" /> Auto-reply is locked by your agency.
        </p>
      )}
      {load.state === "ready" && load.gatesOn && settings && (
        <div className="mt-3 space-y-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(e) => change({ enabled: e.target.checked })}
              disabled={readOnly || (!load.available && !settings.enabled)}
              className="h-4 w-4"
              data-testid="rep-settings-autoreply-enabled"
            />
            Auto-reply to Google reviews
          </label>
          {!load.available && (
            <p className="text-xs text-muted-foreground" data-testid="rep-settings-autoreply-unavailable">Auto-reply is not available yet.</p>
          )}
          <p className="text-xs text-muted-foreground" data-testid="rep-settings-autoreply-texted-note">
            Reviews with written text always wait for approval.
          </p>
          <div className="divide-y rounded-lg border">
            {STARS.map((star) => (
              <div key={star} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm" data-testid={`rep-settings-autoreply-star-${star}`}>
                <span>{`${star}★`}</span>
                <div className="flex gap-4">
                  {(["auto", "approval"] as const).map((mode) => (
                    <label key={mode} className="flex items-center gap-1.5">
                      <input
                        type="radio"
                        name={`autoreply-star-${star}`}
                        checked={settings.modes[star] === mode}
                        onChange={() => change({ modes: { ...settings.modes, [star]: mode } })}
                        disabled={readOnly}
                        data-testid={`rep-settings-autoreply-star-${star}-${mode}`}
                      />
                      {mode === "auto" ? "Auto" : "Approval"}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.includeBacklog}
              onChange={(e) => change({ includeBacklog: e.target.checked })}
              disabled={readOnly}
              className="mt-0.5 h-4 w-4"
              data-testid="rep-settings-autoreply-backlog"
            />
            <span>Also reply to older unreplied reviews (newest first, within the daily limit)</span>
          </label>
          <p className="text-xs text-muted-foreground" data-testid="rep-settings-autoreply-caps">
            {`At most ${load.dailyPostCap} auto-posted replies and ${load.dailyDraftCap} auto-drafts a day.`}
          </p>
          {error && <p className="text-xs text-destructive" role="alert" data-testid="rep-settings-autoreply-save-error">{error}</p>}
          {saved && <p className="text-xs text-emerald-700 dark:text-emerald-400" role="status" data-testid="rep-settings-autoreply-saved">Saved.</p>}
          {isAdmin ? (
            <Button type="button" size="sm" onClick={save} disabled={saving} data-testid="rep-settings-autoreply-save">
              {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}Save auto-reply
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground" data-testid="rep-settings-autoreply-readonly">Only a sub-account admin can change auto-reply.</p>
          )}
        </div>
      )}
    </section>
  );
}
