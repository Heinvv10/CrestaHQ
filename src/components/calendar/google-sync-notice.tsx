"use client";

import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CalendarEvent } from "@/types/events";

/**
 * A booking that didn't reach (or leave) a host's Google Calendar. The push
 * records why on the event (`googleSyncError`); nothing retries it on its
 * own, so the operator gets the reason and a Retry sync button.
 * `onSynced` runs only when the retry's 200 says the event is now synced.
 */
export function GoogleSyncNotice({
  event,
  onSynced,
}: {
  event: CalendarEvent;
  onSynced?: () => void;
}) {
  const error = (event as { googleSyncError?: { message?: string } | null }).googleSyncError?.message;
  const [busy, setBusy] = useState(false);
  if (!error) return null;

  async function retry() {
    setBusy(true);
    try {
      const res = await fetch(`/api/events/by-id/${event.id}/google-sync`, { method: "POST" });
      const data = (await res.json().catch(() => ({}))) as {
        synced?: boolean;
        googleSyncError?: string | null;
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Retry failed.");
      if (data.synced === true) onSynced?.();
      if (data.googleSyncError) toast.error(data.googleSyncError);
      else toast.success("Synced to Google Calendar.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Retry failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="mt-3 flex flex-wrap items-start justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-800 dark:text-amber-300"
      data-testid="google-sync-error"
    >
      <p className="flex min-w-0 flex-1 items-start gap-1.5">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{error}</span>
      </p>
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={retry} data-testid="google-sync-retry">
        {busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
        Retry sync
      </Button>
    </div>
  );
}
