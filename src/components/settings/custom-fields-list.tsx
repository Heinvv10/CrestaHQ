"use client";

import { Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { groupFieldsByFolder } from "@/lib/custom-fields/folders";
import {
  CUSTOM_FIELD_TYPE_LABELS,
  GENERAL_FOLDER_NAME,
  type CustomFieldDef,
  type CustomFieldFolder,
} from "@/types/custom-fields";

/**
 * The defined fields for one entity, grouped under their folders (General
 * first). Each row carries a "Move to folder" select and a delete button;
 * the parent owns the API calls.
 */
export function CustomFieldsList({
  fields,
  folders,
  deletingId,
  onMove,
  onDelete,
}: {
  fields: CustomFieldDef[];
  folders: CustomFieldFolder[];
  deletingId: string | null;
  onMove: (fieldId: string, folderId: string | null) => void;
  onDelete: (fieldId: string) => void;
}) {
  const groups = groupFieldsByFolder(fields, folders).filter(
    (g) => g.folder !== null || g.fields.length > 0
  );

  return (
    <div className="space-y-3">
      {groups.map(({ folder, fields: inFolder }) => (
        <section
          key={folder?.id ?? "general"}
          aria-label={folder?.name ?? GENERAL_FOLDER_NAME}
          className="space-y-2"
        >
          <h3 className="text-muted-foreground text-xs font-medium">
            {folder?.name ?? GENERAL_FOLDER_NAME}
          </h3>
          {inFolder.length === 0 ? (
            <p className="bg-background text-muted-foreground rounded-lg border border-dashed p-2.5 text-[11px]">
              No fields in this folder.
            </p>
          ) : (
            <ul className="space-y-2">
              {inFolder.map((f) => (
                <li
                  key={f.id}
                  className="bg-background flex flex-wrap items-center gap-2 rounded-lg border p-2.5"
                >
                  <span className="text-sm font-medium">{f.label}</span>
                  <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[10px] font-medium">
                    {CUSTOM_FIELD_TYPE_LABELS[f.type]}
                  </span>
                  {f.required && (
                    <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
                      Required
                    </span>
                  )}
                  {f.options.length > 0 && (
                    <span className="text-muted-foreground truncate text-[11px]">
                      {f.options.join(" · ")}
                    </span>
                  )}
                  <code className="text-muted-foreground/70 ml-auto text-[10px]">
                    {f.key}
                  </code>
                  {folders.length > 0 && (
                    <select
                      aria-label={`Move ${f.label} to folder`}
                      value={folder?.id ?? ""}
                      onChange={(e) => onMove(f.id, e.target.value || null)}
                      className="bg-background h-7 rounded-md border px-1.5 text-xs"
                    >
                      <option value="">{GENERAL_FOLDER_NAME}</option>
                      {folders.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={deletingId !== null}
                    onClick={() => onDelete(f.id)}
                    title="Delete field"
                  >
                    {deletingId === f.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}
