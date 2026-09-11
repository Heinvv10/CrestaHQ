"use client";

import { useState, type FormEvent } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { SmartListDoc } from "@/types/contacts";

type Pending =
  | { kind: "save" }
  | { kind: "rename"; list: SmartListDoc }
  | { kind: "delete"; list: SmartListDoc };

interface Props {
  lists: SmartListDoc[];
  /** null = the built-in "All" tab. */
  activeId: string | null;
  onSelect: (id: string | null) => void;
  /** Enabled only when the panel holds at least one condition. */
  canSave: boolean;
  /** Each resolves true when the write succeeded; the dialog stays open otherwise. */
  onSave: (name: string) => Promise<boolean>;
  onRename: (id: string, name: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
}

export function SmartListTabs({
  lists,
  activeId,
  onSelect,
  canSave,
  onSave,
  onRename,
  onDelete,
}: Props) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const active = lists.find((l) => l.id === activeId) ?? null;

  const open = (p: Pending) => {
    setName(p.kind === "rename" ? p.list.name : "");
    setPending(p);
  };
  const close = () => {
    if (!busy) setPending(null);
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!pending) return;
    const trimmed = name.trim();
    if (pending.kind !== "delete" && !trimmed) return;
    setBusy(true);
    try {
      const ok =
        pending.kind === "save"
          ? await onSave(trimmed)
          : pending.kind === "rename"
            ? await onRename(pending.list.id, trimmed)
            : await onDelete(pending.list.id);
      if (ok) setPending(null);
    } finally {
      setBusy(false);
    }
  }

  const tabClass = (selected: boolean) =>
    cn(
      "rounded-md px-3 py-1.5 text-sm transition-colors",
      selected
        ? "bg-primary text-primary-foreground"
        : "text-muted-foreground hover:bg-muted hover:text-foreground",
    );

  return (
    <div className="flex flex-wrap items-center gap-1" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={activeId === null}
        className={tabClass(activeId === null)}
        onClick={() => onSelect(null)}
      >
        All
      </button>
      {lists.map((l) => (
        <button
          key={l.id}
          type="button"
          role="tab"
          aria-selected={l.id === activeId}
          className={tabClass(l.id === activeId)}
          onClick={() => onSelect(l.id)}
        >
          {l.name}
        </button>
      ))}
      {active && (
        <>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="Rename list"
            onClick={() => open({ kind: "rename", list: active })}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="Delete list"
            onClick={() => open({ kind: "delete", list: active })}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="ml-auto"
        disabled={!canSave}
        onClick={() => open({ kind: "save" })}
      >
        <Plus className="mr-1 h-3.5 w-3.5" />
        Save as smart list
      </Button>

      <Dialog open={pending !== null} onOpenChange={(o) => !o && close()}>
        <DialogContent>
          <form onSubmit={submit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>
                {pending?.kind === "save" && "Save as smart list"}
                {pending?.kind === "rename" && "Rename list"}
                {pending?.kind === "delete" && "Delete list"}
              </DialogTitle>
              <DialogDescription>
                {pending?.kind === "delete"
                  ? `“${pending.list.name}” will be removed for everyone in this workspace. Contacts are not affected.`
                  : "The current filters are saved under this name and shared with the workspace."}
              </DialogDescription>
            </DialogHeader>
            {pending?.kind !== "delete" && (
              <Input
                id="smart-list-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="List name"
                autoFocus
              />
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={close} disabled={busy}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant={pending?.kind === "delete" ? "destructive" : "default"}
                disabled={busy}
              >
                {pending?.kind === "delete" ? "Delete list" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
