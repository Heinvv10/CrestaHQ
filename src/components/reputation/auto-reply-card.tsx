"use client";

import { useEffect, useState } from "react";
import { Loader2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AutoReplyStar, ReviewsAutoReplySettings } from "@/types";

/**
 * Reputation → Settings: the "Auto-reply" card (AUTO_REPLY_V1_PLAN.md, UI) —
 * master switch, Auto / Approval per star, the backlog option, and the daily
 * caps read-only (the server's constants, via GET). Every save sends the whole
 * `{enabled, modes, includeBacklog}` the route allow-lists; a refusal
 * (`no_listing`, `listing_shared`, a gate) shows inline. Locked, naming the
 * gate, while any of the three agency gates is off; says so when this
 * deployment's engine does not run (the kill switch, as a boolean) and when a
 * listing change switched auto-reply off.
 *
 * Shown since PR 3, together with the Reviews tab's "Needs approval" filter.
 *
 * With extra listings (MULTI_LISTING_V1_PLAN.md PR 6): one switch per
 * connected listing, by title — the main listing's row is the master switch
 * (`enabled`), each extra's goes in `listings`; stars, backlog and the daily
 * caps are shared across listings. With one listing the card is unchanged.
 */
export const AUTO_REPLY_UI_ENABLED = true;

type Settings = Pick<ReviewsAutoReplySettings, "enabled" | "modes" | "includeBacklog">;
/** One connected listing as GET/PUT report it; `enabled` is the extra's own switch (main's is `Settings.enabled`). */
type Listing = { locationName: string; title: string; main: boolean; enabled: boolean };
const readListings = (v: unknown): Listing[] =>
  Array.isArray(v)
    ? v.filter((l): l is Listing => typeof l?.locationName === "string" && typeof l?.title === "string")
      .map((l) => ({ locationName: l.locationName, title: l.title, main: l.main === true, enabled: l.enabled === true }))
    : [];
type Gate = "gate_off" | "ai_gate_off" | "auto_reply_gate_off";
type Load =
  | { state: "loading" }
  | { state: "error" }
  | { state: "ready"; gate: Gate | null; available: boolean; running: boolean; dailyPostCap: number; dailyDraftCap: number };

const LOCKED: Record<Gate, string> = {
  gate_off: "Auto-reply is locked: your agency has not enabled Google Business Profile for this sub-account.",
  ai_gate_off: "Auto-reply is locked: your agency has not enabled Reviews AI for this sub-account.",
  auto_reply_gate_off: "Auto-reply is locked: your agency has not enabled review auto-reply for this sub-account.",
};
const isGate = (v: unknown): v is Gate => typeof v === "string" && v in LOCKED;

const STARS: AutoReplyStar[] = [1, 2, 3, 4, 5];

export function AutoReplyCard({ subAccountId, isAdmin }: { subAccountId: string; isAdmin: boolean }) {
  const api = `/api/sub-accounts/${subAccountId}/reputation/auto-reply`;
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listingChanged, setListingChanged] = useState(false);
  const [listings, setListings] = useState<Listing[]>([]);
  const extras = listings.filter((l) => !l.main);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const res = await fetch(api, { signal: controller.signal }).catch(() => null);
      const data = (await res?.json().catch(() => null)) as
        | (Settings & {
            gatesOn?: boolean; gate?: unknown; available?: boolean; running?: boolean; disabledReason?: unknown;
            dailyPostCap?: number; dailyDraftCap?: number; listings?: unknown;
          })
        | null;
      if (controller.signal.aborted) return;
      if (!res?.ok || !data || typeof data.enabled !== "boolean" || !data.modes) return setLoad({ state: "error" });
      setSettings({ enabled: data.enabled, modes: data.modes, includeBacklog: data.includeBacklog === true });
      setListingChanged(data.disabledReason === "listing_changed");
      setListings(readListings(data.listings));
      // Fail closed: gates not reported on reads as locked by the auto-reply gate.
      const gate = data.gatesOn === true ? null : isGate(data.gate) ? data.gate : "auto_reply_gate_off";
      setLoad({
        state: "ready", gate, available: data.available === true, running: data.running === true,
        dailyPostCap: Number(data.dailyPostCap), dailyDraftCap: Number(data.dailyDraftCap),
      });
    })();
    return () => controller.abort();
  }, [api]);

  const change = (patch: Partial<Settings>) => {
    setSettings((s) => (s ? { ...s, ...patch } : s));
    setSaved(false);
  };

  const switchExtra = (locationName: string, enabled: boolean) => {
    setListings((ls) => ls.map((l) => (l.locationName === locationName ? { ...l, enabled } : l)));
    setSaved(false);
  };

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    // Extra listings' switches only when there are any: a one-listing body is exactly as before.
    const body = extras.length > 0
      ? { ...settings, listings: Object.fromEntries(extras.map((l) => [l.locationName, l.enabled])) }
      : settings;
    const res = await fetch(api, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const data = (await res?.json().catch(() => null)) as
      | { error?: string; reviewsAutoReply?: Settings & { disabledReason?: unknown; listings?: unknown } }
      | null;
    setSaving(false);
    if (res?.ok && data?.reviewsAutoReply) {
      const r = data.reviewsAutoReply;
      setSettings({ enabled: r.enabled, modes: r.modes, includeBacklog: r.includeBacklog });
      setListingChanged(r.disabledReason === "listing_changed");
      if (r.listings !== undefined) setListings(readListings(r.listings));
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
      {load.state === "ready" && load.gate && (
        <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground" data-testid="rep-settings-autoreply-locked" data-gate={load.gate}>
          <Lock className="h-4 w-4 shrink-0" /> {LOCKED[load.gate]}
        </p>
      )}
      {load.state === "ready" && !load.gate && settings && (
        <div className="mt-3 space-y-3">
          {extras.length > 0 && (
            <p className="text-sm text-muted-foreground" data-testid="rep-settings-autoreply-listings-note">Auto-reply to Google reviews on:</p>
          )}
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(e) => change({ enabled: e.target.checked })}
              disabled={readOnly || (!load.available && !settings.enabled)}
              className="h-4 w-4"
              data-testid="rep-settings-autoreply-enabled"
            />
            {extras.length > 0 ? listings.find((l) => l.main)?.title ?? "Main listing" : "Auto-reply to Google reviews"}
          </label>
          {extras.map((l) => (
            <label key={l.locationName} className="flex items-center gap-2 text-sm font-medium" data-testid="rep-settings-autoreply-listing" data-location={l.locationName}>
              <input
                type="checkbox"
                checked={l.enabled}
                onChange={(e) => switchExtra(l.locationName, e.target.checked)}
                disabled={readOnly || (!load.available && !l.enabled)}
                className="h-4 w-4"
                data-testid="rep-settings-autoreply-listing-enabled"
              />
              {l.title}
            </label>
          ))}
          {!load.available && (
            <p className="text-xs text-muted-foreground" data-testid="rep-settings-autoreply-unavailable">Auto-reply is not available yet.</p>
          )}
          {load.available && !load.running && (
            <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="rep-settings-autoreply-not-running">
              Auto-reply isn&apos;t running on this deployment yet — settings are saved, but nothing is drafted or posted.
            </p>
          )}
          {listingChanged && !settings.enabled && (
            <p className="text-xs text-amber-700 dark:text-amber-400" data-testid="rep-settings-autoreply-listing-changed">
              Switched off because the Google listing changed — switch on again to resume.
            </p>
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
          {extras.length > 0 && (
            <p className="text-xs text-muted-foreground" data-testid="rep-settings-autoreply-caps-shared">
              The star settings, the backlog option and the daily limits are shared across listings.
            </p>
          )}
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
