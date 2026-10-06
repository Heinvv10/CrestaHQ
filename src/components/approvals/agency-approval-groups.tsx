"use client";

import { useState } from "react";
import { CheckCheck, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ApprovalCard } from "@/components/approvals/approval-card";
import { approveAll, batchEligible, type AgencyApprovalRow } from "@/lib/approvals/agency-batch";
import { CLASS_LABELS } from "@/lib/approvals/messages";
import { formatRelativeTime } from "@/lib/format";

/**
 * The agency approvals queue, grouped by the sub-account each row acts on.
 * Rows decide through the agency route. "Approve all" covers only the rows
 * `batchEligible` allows and says how many it skips.
 */
export function AgencyApprovalGroups({
  rows,
  onReplace,
  onChanged,
}: {
  rows: AgencyApprovalRow[];
  onReplace: (row: AgencyApprovalRow) => void;
  onChanged: () => Promise<void>;
}) {
  const [running, setRunning] = useState(false);
  const pending = rows.filter((r) => r.status === "pending");
  const eligible = pending.filter(batchEligible);
  const skipped = pending.length - eligible.length;

  async function runAll() {
    setRunning(true);
    try {
      const { approved, unsettled, refused } = await approveAll(eligible);
      const notes = [
        unsettled > 0 && `${unsettled} still running, so the outcome isn't known yet; check back soon.`,
        refused > 0 && `${refused} changed or were refused; review them one by one.`,
      ].filter(Boolean);
      if (notes.length > 0) toast.warning([`Approved ${approved}.`, ...notes].join(" "));
      else toast.success(`Approved ${approved}.`);
    } catch {
      toast.error("Couldn't reach the server. Try again.");
    } finally {
      await onChanged();
      setRunning(false);
    }
  }

  return (
    <div className="space-y-4">
      {eligible.length > 0 && (
        <div className="flex flex-wrap items-center gap-3" data-testid="approve-all-bar">
          <Button size="sm" disabled={running} onClick={() => void runAll()} data-testid="approve-all">
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCheck className="h-4 w-4" />}
            Approve all ({eligible.length})
          </Button>
          {skipped > 0 && (
            <span className="text-muted-foreground text-sm">
              skips {skipped} that need their own click
            </span>
          )}
        </div>
      )}
      {groupByTarget(rows).map(([targetId, group]) => (
        <div key={targetId} className="space-y-3" data-testid={`approval-group-${targetId}`}>
          <h3 className="text-sm font-semibold">{group[0]!.targetName}</h3>
          {group.map((r) => (
            <ApprovalCard
              key={r.id}
              subAccountId={r.targetSubAccountId}
              decideBase="/api/agency/agent-proposals"
              row={r}
              onReplace={(next) => onReplace({ ...r, ...next })}
              onChanged={onChanged}
              meta={
                <p className="text-muted-foreground text-xs" data-testid="approval-meta">
                  {CLASS_LABELS[r.approval] ?? r.approval} · key {r.keyPrefix ?? "unknown"} ·{" "}
                  {formatRelativeTime(r.createdAt ? new Date(r.createdAt) : null)}
                </p>
              }
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Rows by target, in the order each target first appears (newest first). */
function groupByTarget(rows: AgencyApprovalRow[]): Array<[string, AgencyApprovalRow[]]> {
  const groups = new Map<string, AgencyApprovalRow[]>();
  for (const r of rows) groups.set(r.targetSubAccountId, [...(groups.get(r.targetSubAccountId) ?? []), r]);
  return [...groups.entries()];
}
