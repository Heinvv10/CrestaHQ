"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import type { SnapshotShareStatus, SnapshotShareSummary } from "@/types/snapshots";

const STATUS_LABEL: Record<SnapshotShareStatus, string> = {
  active: "Active",
  expired: "Expired",
  revoked: "Revoked",
  used: "Used",
};

const STATUS_CLASS: Record<SnapshotShareStatus, string> = {
  active: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  expired: "bg-muted text-muted-foreground",
  revoked: "bg-red-500/10 text-red-700 dark:text-red-400",
  used: "bg-muted text-muted-foreground",
};

const formatDate = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

/** The agency's share links, with a Revoke action on the live ones. */
export function SnapshotSharesList({
  shares,
  loading,
  onChanged,
}: {
  shares: SnapshotShareSummary[];
  loading: boolean;
  onChanged: () => Promise<void>;
}) {
  const [revoking, setRevoking] = useState<string | null>(null);

  async function revoke(share: SnapshotShareSummary) {
    if (revoking) return;
    setRevoking(share.id);
    try {
      const res = await fetch(
        `/api/agency/snapshots/${share.snapshotId}/shares/${share.id}`,
        { method: "DELETE" },
      );
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Revoke failed.");
      toast.success("Share link revoked.");
      await onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Revoke failed.");
    } finally {
      setRevoking(null);
    }
  }

  if (loading) return <div className="h-20 animate-pulse rounded-lg bg-muted/50" />;
  if (shares.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        No share links yet. Use Share on one of your snapshots.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {shares.map((share) => (
        <div
          key={share.id}
          data-testid="snapshot-share-row"
          data-share-id={share.id}
          className="flex flex-wrap items-center gap-3 rounded-lg border bg-background p-4"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{share.snapshotName}</p>
            <p className="text-xs text-muted-foreground">
              Expires {formatDate(share.expiresAt)} ·{" "}
              {share.singleUse ? "Single use" : "Multi use"} · Used{" "}
              {share.usedCount} {share.usedCount === 1 ? "time" : "times"}
            </p>
          </div>
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_CLASS[share.status]}`}
          >
            {STATUS_LABEL[share.status]}
          </span>
          {share.status !== "revoked" && (
            <Button
              variant="outline"
              size="sm"
              data-testid="snapshot-share-revoke"
              disabled={revoking === share.id}
              onClick={() => revoke(share)}
            >
              Revoke
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
