"use client";

import { useState, type ReactNode } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  Inbox,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { WorkflowFolder } from "@/types/workflows";

/**
 * One group on the workflows list: a collapsible header (name, count, and
 * for a real folder inline rename + delete) above its rows. `folder` null is
 * the implicit Unfiled group, which cannot be renamed or deleted.
 */
export function WorkflowFolderSection({
  folder,
  count,
  busy,
  onRename,
  onDelete,
  children,
}: {
  folder: WorkflowFolder | null;
  count: number;
  busy: boolean;
  onRename: (name: string) => Promise<boolean>;
  onDelete: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const label = folder?.name ?? "Unfiled";

  return (
    <section
      data-testid="workflow-folder"
      data-folder={folder?.id ?? "unfiled"}
      data-name={label}
      data-count={count}
      className="overflow-hidden rounded-xl border bg-card"
    >
      <div className="flex items-center gap-2 border-b bg-muted/30 px-3 py-2">
        {editing && folder ? (
          <>
            <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
            <Input
              aria-label="Folder name"
              data-testid="folder-rename-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-7"
              autoFocus
            />
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              title="Save name"
              data-testid="folder-rename-save"
              onClick={async () => {
                if (await onRename(name.trim())) setEditing(false);
              }}
            >
              <Check className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              title="Cancel"
              onClick={() => setEditing(false)}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium"
            >
              {open ? (
                <ChevronDown className="h-4 w-4 shrink-0" />
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0" />
              )}
              {folder ? (
                <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : (
                <Inbox className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate">{label}</span>
              <span className="rounded-full bg-muted px-2 text-xs text-muted-foreground">
                {count}
              </span>
            </button>
            {folder && (
              <>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  disabled={busy}
                  title="Rename folder"
                  data-testid="folder-rename"
                  onClick={() => {
                    setName(folder.name);
                    setEditing(true);
                  }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  disabled={busy}
                  title="Delete folder (its workflows move to Unfiled)"
                  data-testid="folder-delete"
                  onClick={onDelete}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </>
            )}
          </>
        )}
      </div>
      {open &&
        (count === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No workflows here.</p>
        ) : (
          <div className="divide-y">{children}</div>
        ))}
    </section>
  );
}

/** Inline "new folder" row shown above the list. */
export function NewFolderInput({
  busy,
  onSave,
  onCancel,
}: {
  busy: boolean;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  return (
    <div className="flex items-center gap-2 rounded-xl border bg-card p-3">
      <Input
        aria-label="New folder name"
        data-testid="folder-new-input"
        placeholder="Folder name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSave(name.trim());
        }}
        className="h-8"
        autoFocus
      />
      <Button
        size="sm"
        disabled={busy}
        data-testid="folder-new-save"
        onClick={() => onSave(name.trim())}
      >
        <Check className="h-3.5 w-3.5" />
      </Button>
      <Button size="sm" variant="ghost" title="Cancel" onClick={onCancel}>
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
