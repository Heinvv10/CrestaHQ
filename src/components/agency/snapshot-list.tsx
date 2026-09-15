"use client";

import Link from "next/link";
import { Share2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface SnapshotSummary {
  id: string;
  name: string;
  description: string;
  sourceSubAccountId: string | null;
  createdAt: number | null;
  /** Set when the snapshot was imported through another agency's link. */
  importedFrom: { importedAt: number | null } | null;
  counts: {
    forms: number;
    messageTemplates: number;
    products: number;
    workflows: number;
    /** Absent on snapshots captured before these were carried. */
    customFields?: number;
    /** 1 when the snapshot carries an AI persona, 0 otherwise. */
    aiProfile?: number;
  };
}

function countsLine(snap: SnapshotSummary) {
  const c = snap.counts;
  return (
    `${c.forms} forms · ${c.workflows} workflows · ${c.messageTemplates} templates · ` +
    `${c.products} products · ${c.customFields ?? 0} custom fields` +
    (c.aiProfile ? " · AI persona" : "")
  );
}

/**
 * One tab's snapshot rows. "mine" rows carry a Share button; "imported" rows
 * say where they came from. Both apply the same way — from the new
 * sub-account form's snapshot picker.
 */
export function SnapshotList({
  variant,
  snapshots,
  loading,
  subLabel,
  onShare,
}: {
  variant: "mine" | "imported";
  snapshots: SnapshotSummary[];
  loading: boolean;
  subLabel: (id: string | null) => string;
  onShare: (snap: SnapshotSummary) => void;
}) {
  if (loading) return <div className="h-20 animate-pulse rounded-lg bg-muted/50" />;
  if (snapshots.length === 0) {
    return (
      <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        {variant === "mine"
          ? "No snapshots yet. Capture one above."
          : "No imported snapshots. Use Import from file with a snapshot file someone shared with you."}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {snapshots.map((snap) => (
        <div
          key={snap.id}
          data-testid={variant === "imported" ? "snapshot-imported-row" : undefined}
          data-snapshot-id={snap.id}
          className="flex flex-wrap items-center gap-3 rounded-lg border bg-background p-4"
        >
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{snap.name}</p>
            <p className="text-xs text-muted-foreground">
              {countsLine(snap)}
              {variant === "mine"
                ? ` · from ${subLabel(snap.sourceSubAccountId)}`
                : ` · Imported from another agency${
                    snap.importedFrom?.importedAt
                      ? ` · ${new Date(snap.importedFrom.importedAt).toLocaleDateString()}`
                      : ""
                  }`}
            </p>
          </div>
          {variant === "mine" ? (
            <Button
              variant="outline"
              size="sm"
              data-testid="snapshot-share-button"
              onClick={() => onShare(snap)}
            >
              <Share2 className="mr-1 h-3.5 w-3.5" />
              Share
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              render={<Link href="/agency/sub-accounts/new" />}
            >
              Use in new sub-account
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}
