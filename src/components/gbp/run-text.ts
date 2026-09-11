/** A run as GET /gbp/reviews and POST /gbp/sync return it (lib/gbp/sync/public.ts). */
export interface RunView {
  trigger?: string;
  status: string;
  finishedAt?: string | null;
  created?: number;
  updated?: number;
  removed?: number;
  errorKind: string | null;
  skipReason: string | null;
}

const SKIP_TEXT: Record<string, string> = {
  already_running: "A sync is already running — try again in a minute.",
  listing_changed: "The listing or connection changed while it started — nothing was synced.",
  reconnect_required: "Google needs to be reconnected before syncing.",
  no_listing: "Choose a listing first.",
  not_connected: "Google is not connected.",
  gate_off: "This feature is locked by your agency.",
};

/** One honest sentence for what a run did. */
export function describeRun(run: RunView): string {
  if (run.status === "skipped") return SKIP_TEXT[run.skipReason ?? ""] ?? "Sync skipped.";
  const counts = `${run.created ?? 0} new, ${run.updated ?? 0} updated, ${run.removed ?? 0} removed`;
  if (run.status === "success") return `Synced: ${counts}.`;
  if (run.status === "partial") return `Partly synced (${counts}) — the next sync carries on.`;
  if (run.status === "reconnect_required") return "Google refused this connection — reconnect to resume syncing.";
  return `Sync failed (${run.errorKind ?? "unknown"}). Cached reviews are kept.`;
}
