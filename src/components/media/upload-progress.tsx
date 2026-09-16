"use client";

import { CheckCircle2, Loader2, XCircle } from "lucide-react";

export interface UploadItem {
  id: string;
  name: string;
  fraction: number;
  status: "uploading" | "done" | "error";
  error?: string;
}

export function UploadProgress({ items }: { items: UploadItem[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="space-y-1.5 rounded-xl border bg-card p-3 text-xs" data-testid="media-upload-progress">
      {items.map((u) => (
        <li key={u.id} className="flex items-center gap-2">
          {u.status === "uploading" && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />}
          {u.status === "done" && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />}
          {u.status === "error" && <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />}
          <span className="w-40 truncate" title={u.name}>{u.name}</span>
          {u.status === "error" ? (
            <span className="truncate text-destructive">{u.error}</span>
          ) : (
            <div className="h-1.5 flex-1 overflow-hidden rounded bg-muted">
              <div
                className="h-full bg-primary transition-[width]"
                style={{ width: `${Math.round(u.fraction * 100)}%` }}
              />
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
