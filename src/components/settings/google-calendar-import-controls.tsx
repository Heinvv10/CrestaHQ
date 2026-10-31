"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, RefreshCw } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { formatRelativeTime } from "@/lib/format";
import { Button } from "@/components/ui/button";

/**
 * Show the member's Google events on the CRM calendar (Settings → Calendar
 * sync, inside the Google Calendar card). Two keys: a sub-account admin
 * allows it for the workspace, then each person chooses for their OWN
 * calendar. The server enforces both; this only reflects them. Everything
 * comes from GET /api/sub-accounts/[id]/google-calendar, changes go through
 * PATCH .../google-calendar/import.
 */

export type ImportMode = "off" | "busy" | "details";

export interface ImportStatus {
  connected: boolean;
  importAllowed?: boolean;
  importMode?: ImportMode;
  importStatus?: "ok" | "error" | null;
  importError?: string | null;
  importLastSyncAt?: string | null;
  importedCount?: number;
  /** Bumped by every mode change, so a read taken after one never equals one taken before it. */
  importGeneration?: number;
}

const OPTIONS: { value: ImportMode; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "Nothing from your Google Calendar appears in the CRM." },
  { value: "busy", label: "Busy only", hint: "Your team sees when you're busy, with no titles or places." },
  {
    value: "details",
    label: "Full details",
    hint: "Your team sees titles and places. Events you marked private in Google stay Busy.",
  },
];

const DETAILS_CONFIRM =
  "Everyone in this workspace will see the titles, times and places of your Google Calendar events. Events you marked private in Google stay as Busy. Continue?";
const WORKSPACE_OFF_CONFIRM =
  "Turn this off for everyone? Every imported Google event is removed from the CRM calendar now.";

/** The first pass runs after the response; re-read the status a few times until it lands. */
export const POLL_MS = 4_000;
export const POLL_MAX = 5;

const sigOf = (st: ImportStatus) =>
  `${st.importGeneration ?? ""}|${st.importLastSyncAt ?? ""}|${st.importStatus ?? ""}|${st.importError ?? ""}`;
const countLabel = (n: number) => `${n} ${n === 1 ? "event" : "events"}`;

export function GoogleImportControls({ status, onChanged }: { status: ImportStatus; onChanged: () => Promise<void> }) {
  const { subAccountId, isAdmin } = useSubAccount();
  const [saving, setSaving] = useState(false);
  // After a successful switch-on: the status that was on screen when it was made. Until the
  // status shows something different, whatever it says is the PREVIOUS pass's (the server clears
  // it on a mode change, but a stale copy already on screen must not be read as the new pass's).
  const [staleSig, setStaleSig] = useState<string | null>(null);
  // The polls ran out with nothing new reported (the first pass may have been skipped, e.g. by the
  // cooldown). Say so, and offer a manual re-read, instead of claiming progress forever.
  const [gaveUp, setGaveUp] = useState(false);
  const allowed = status.importAllowed === true;
  const mode: ImportMode = status.importMode ?? "off";
  const reported = !!status.importLastSyncAt || !!status.importStatus;
  const syncing = staleSig !== null;
  const pending = mode !== "off" && (syncing || !reported);
  const waiting = pending && !gaveUp;
  const stillSyncing = pending && gaveUp;

  useEffect(() => {
    // Any change from what was on screen (the mode change bumps the generation, so every read
    // after it differs) means what follows is the new pass's, even if it repeats the old message.
    if (staleSig !== null && sigOf(status) !== staleSig) setStaleSig(null);
  }, [staleSig, status]);

  useEffect(() => {
    if (!waiting) return;
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      void onChanged();
      if (tries >= POLL_MAX) {
        clearInterval(timer);
        setGaveUp(true);
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, onChanged]);

  async function patch(body: Record<string, unknown>, success: string) {
    setSaving(true);
    setGaveUp(false);
    const sigBefore = sigOf(status);
    let ok = false;
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/google-calendar/import`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Couldn't save.");
      toast.success(success);
      ok = true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save.");
    } finally {
      setSaving(false);
      await onChanged();
    }
    if (ok && typeof body.mode === "string" && body.mode !== "off") setStaleSig(sigBefore);
  }

  function chooseMode(next: ImportMode) {
    if (next === mode) return;
    if (next === "details" && !confirm(DETAILS_CONFIRM)) return;
    void patch(
      { mode: next },
      next === "off"
        ? "Your Google events were removed from the CRM calendar."
        : "Saved. Your Google events will appear on the CRM calendar shortly.",
    );
  }

  function toggleWorkspace(next: boolean) {
    if (!next && !confirm(WORKSPACE_OFF_CONFIRM)) return;
    void patch(
      { allowWorkspace: next },
      next ? "Team members can now choose to show their Google events." : "Turned off and imported events removed.",
    );
  }

  const lastSync = status.importLastSyncAt ? new Date(status.importLastSyncAt) : null;

  return (
    <div className="mt-4 space-y-3 border-t pt-4" data-testid="gcal-import">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Show Google events on the CRM calendar
      </p>
      {isAdmin && (
        <label className="flex cursor-pointer items-start gap-3 rounded-md border p-3">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 cursor-pointer"
            checked={allowed}
            disabled={saving}
            onChange={(e) => toggleWorkspace(e.target.checked)}
            data-testid="gcal-import-allow"
          />
          <span className="text-xs leading-relaxed">
            <span className="block font-medium">Allow team members to show their Google events</span>
            <span className="text-muted-foreground">
              Off by default. Each person still chooses for their own calendar; admins can&apos;t turn it on for
              someone else.
            </span>
          </span>
        </label>
      )}
      {!allowed ? (
        <p className="text-xs text-muted-foreground" data-testid="gcal-import-not-allowed">
          {isAdmin
            ? "While this is off, nobody's Google events appear in the CRM."
            : "Not enabled in this workspace. Ask an admin if you'd like to show your Google events on the CRM calendar."}
        </p>
      ) : !status.connected ? (
        <p className="text-xs text-muted-foreground" data-testid="gcal-import-connect-first">
          Connect your Google Calendar to choose what to show.
        </p>
      ) : (
        <div className="space-y-2">
          <p className="text-xs font-medium">Your Google Calendar on the CRM calendar</p>
          <div className="grid gap-2 sm:grid-cols-3">
            {OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                disabled={saving}
                onClick={() => chooseMode(o.value)}
                aria-pressed={mode === o.value}
                data-testid={`gcal-import-mode-${o.value}`}
                className={
                  mode === o.value
                    ? "rounded-md border border-primary bg-primary/5 p-2 text-left"
                    : "rounded-md border p-2 text-left hover:bg-muted/40"
                }
              >
                <span className="block text-xs font-medium">{o.label}</span>
                <span className="block text-[11px] leading-snug text-muted-foreground">{o.hint}</span>
              </button>
            ))}
          </div>
          {mode !== "off" && (
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              <span data-testid="gcal-import-status">
                {stillSyncing
                  ? "Still syncing. Refresh in a minute."
                  : syncing
                    ? "First sync in progress…"
                    : status.importStatus === "error"
                      ? `Last sync failed: ${status.importError ?? "unknown error"}`
                      : lastSync
                        ? `${countLabel(status.importedCount ?? 0)}, synced ${formatRelativeTime(lastSync)}. Refreshes about every 15 minutes.`
                        : "First sync in progress…"}
                {!stillSyncing && !syncing && status.importStatus !== "error" && status.importError
                  ? ` ${status.importError}`
                  : ""}
              </span>
              {stillSyncing && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs"
                  onClick={() => {
                    setGaveUp(false);
                    void onChanged();
                  }}
                  data-testid="gcal-import-refresh"
                >
                  Refresh
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                disabled={saving}
                onClick={() => void patch({ syncNow: true }, "Synced with Google Calendar.")}
                data-testid="gcal-import-sync"
              >
                {saving ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <RefreshCw className="mr-1 h-3 w-3" />}
                Sync now
              </Button>
            </div>
          )}
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Imported events are read-only in the CRM and are left out of the API, the assistant and calendar feeds.
            Events marked Free, invites you declined and your own CRM bookings are skipped.
          </p>
        </div>
      )}
    </div>
  );
}
