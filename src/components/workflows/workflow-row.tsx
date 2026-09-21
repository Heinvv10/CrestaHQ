"use client";

import Link from "next/link";
import { Folder, FolderInput, Inbox, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WorkflowStatusBadge } from "./workflow-status-badge";
import { SaveToLibraryButton } from "@/components/templates/save-to-library-dialog";
import { TRIGGER_LABELS } from "@/lib/workflows/catalog";
import type {
  WorkflowFolder,
  WorkflowStatus,
  WorkflowTriggerType,
} from "@/types/workflows";

export interface WorkflowListRow {
  id: string;
  name: string;
  status: WorkflowStatus;
  trigger: { type: WorkflowTriggerType };
  stats?: { enrolled?: number; completed?: number };
  folderId?: string | null;
}

/** One workflow on the list, with a row menu to move it between folders. */
export function WorkflowRow({
  saId,
  workflow: w,
  folders,
  onMove,
  onDelete,
}: {
  saId: string;
  workflow: WorkflowListRow;
  folders: WorkflowFolder[];
  onMove: (folderId: string | null) => void;
  onDelete: () => void;
}) {
  const current = folders.some((f) => f.id === w.folderId) ? w.folderId : null;
  const targets = folders.filter((f) => f.id !== current);

  return (
    <div
      data-testid="workflow-row"
      data-name={w.name}
      className="flex items-center gap-3 p-4 hover:bg-muted/40"
    >
      <Link href={`/sa/${saId}/workflows/${w.id}`} className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{w.name}</span>
          <WorkflowStatusBadge status={w.status} />
        </div>
        <div className="text-xs text-muted-foreground">
          {TRIGGER_LABELS[w.trigger?.type] ?? w.trigger?.type} ·{" "}
          {w.stats?.enrolled ?? 0} enrolled
        </div>
      </Link>
      <SaveToLibraryButton
        subAccountId={saId}
        kind="workflow"
        entityId={w.id}
        entityName={w.name}
        iconOnly
      />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              type="button"
              title="Move to folder"
              data-testid="workflow-move"
            />
          }
        >
          <FolderInput className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Move to folder</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {targets.map((f) => (
              <DropdownMenuItem
                key={f.id}
                data-testid="workflow-move-target"
                data-name={f.name}
                onClick={() => onMove(f.id)}
              >
                <Folder className="h-4 w-4" /> {f.name}
              </DropdownMenuItem>
            ))}
            {current !== null && (
              <DropdownMenuItem
                data-testid="workflow-move-target"
                data-name="Unfiled"
                onClick={() => onMove(null)}
              >
                <Inbox className="h-4 w-4" /> Unfiled
              </DropdownMenuItem>
            )}
            {targets.length === 0 && current === null && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                Create a folder first.
              </p>
            )}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onDelete}>
        <Trash2 className="h-4 w-4" />
      </Button>
    </div>
  );
}
