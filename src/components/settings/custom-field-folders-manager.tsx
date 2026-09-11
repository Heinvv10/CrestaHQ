"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Folder,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { movedFolderIds } from "@/lib/custom-fields/folders";
import type {
  CustomFieldEntity,
  CustomFieldFolder,
} from "@/types/custom-fields";

/**
 * Folder list for one entity's custom fields: create, rename, reorder
 * (swap `order` with a neighbour), delete (server moves its fields to
 * General). Folders arrive live from the parent; every write goes through
 * /api/sub-accounts/[id]/custom-field-folders.
 */
export function CustomFieldFoldersManager({
  subAccountId,
  entity,
  folders,
}: {
  subAccountId: string;
  entity: CustomFieldEntity;
  folders: CustomFieldFolder[];
}) {
  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [busy, setBusy] = useState(false);

  const base = `/api/sub-accounts/${subAccountId}/custom-field-folders`;

  async function call(
    url: string,
    init: RequestInit,
    fail: string
  ): Promise<boolean> {
    setBusy(true);
    try {
      const res = await fetch(url, {
        headers: { "Content-Type": "application/json" },
        ...init,
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        toast.error(data.error ?? fail);
        return false;
      }
      return true;
    } catch {
      toast.error(fail);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (!newName.trim()) {
      toast.error("Give the folder a name.");
      return;
    }
    const ok = await call(
      base,
      {
        method: "POST",
        body: JSON.stringify({ name: newName.trim(), entity }),
      },
      "Couldn't create the folder."
    );
    if (ok) {
      toast.success("Folder created.");
      setNewName("");
    }
  }

  async function rename(id: string) {
    const ok = await call(
      `${base}/${id}`,
      { method: "PATCH", body: JSON.stringify({ name: editName.trim() }) },
      "Couldn't rename the folder."
    );
    if (ok) setEditingId(null);
  }

  async function move(index: number, dir: -1 | 1) {
    const ids = movedFolderIds(folders, index, dir);
    if (!ids) return;
    // One request renumbers every folder 0..n-1, so stored `order` values
    // that went sparse after a delete cannot scramble the result.
    await call(
      `${base}/reorder`,
      { method: "PUT", body: JSON.stringify({ entity, ids }) },
      "Couldn't reorder folders.",
    );
  }

  async function remove(f: CustomFieldFolder) {
    if (
      !confirm(
        `Delete the "${f.name}" folder? Its fields move back to General.`
      )
    ) {
      return;
    }
    const ok = await call(
      `${base}/${f.id}`,
      { method: "DELETE" },
      "Couldn't delete the folder."
    );
    if (ok) toast.success("Folder deleted; its fields are now in General.");
  }

  return (
    <div className="bg-background mb-4 space-y-2 rounded-lg border p-3">
      <p className="text-xs font-medium">Folders</p>
      {folders.length > 0 && (
        <ul className="space-y-1.5" aria-label="Custom field folders">
          {folders.map((f, i) => (
            <li
              key={f.id}
              className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm"
            >
              <Folder className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
              {editingId === f.id ? (
                <>
                  <Input
                    aria-label="Folder name"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="h-7"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => rename(f.id)}
                    title="Save name"
                  >
                    <Check className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditingId(null)}
                    title="Cancel"
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy || i === 0}
                    onClick={() => move(i, -1)}
                    title="Move up"
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy || i === folders.length - 1}
                    onClick={() => move(i, 1)}
                    title="Move down"
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => {
                      setEditingId(f.id);
                      setEditName(f.name);
                    }}
                    title="Rename folder"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => remove(f)}
                    title="Delete folder"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2">
        <Input
          aria-label="New folder name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="e.g. Billing"
          className="h-8"
        />
        <Button type="button" size="sm" disabled={busy} onClick={create}>
          {busy ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Plus className="mr-1 h-3.5 w-3.5" />
          )}
          Add folder
        </Button>
      </div>
    </div>
  );
}
