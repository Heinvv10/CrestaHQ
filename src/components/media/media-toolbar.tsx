"use client";

import { ChevronRight, FolderPlus, Search, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { MediaFolderDoc, MediaKind } from "@/types/media";

export type KindFilter = "all" | MediaKind;

const FILTERS: Array<{ id: KindFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "image", label: "Images" },
  { id: "video", label: "Videos" },
  { id: "document", label: "Documents" },
];

/** Root → … → current, following `parentId` up the chain. */
export function folderTrail(folders: MediaFolderDoc[], currentId: string | null): MediaFolderDoc[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const trail: MediaFolderDoc[] = [];
  let cursor = currentId ? byId.get(currentId) : undefined;
  while (cursor && trail.length < 50) {
    trail.unshift(cursor);
    cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
  }
  return trail;
}

export function MediaToolbar({
  folders,
  currentFolderId,
  search,
  filter,
  onNavigate,
  onSearch,
  onFilter,
  canManage,
  onNewFolder,
  onUpload,
}: {
  folders: MediaFolderDoc[];
  currentFolderId: string | null;
  search: string;
  filter: KindFilter;
  onNavigate: (folderId: string | null) => void;
  onSearch: (v: string) => void;
  onFilter: (f: KindFilter) => void;
  canManage: boolean;
  onNewFolder: () => void;
  onUpload: () => void;
}) {
  const trail = folderTrail(folders, currentFolderId);
  return (
    <div className="space-y-3">
      <nav aria-label="Folder path" className="flex flex-wrap items-center gap-1 text-sm" data-testid="media-breadcrumb">
        <button
          type="button"
          onClick={() => onNavigate(null)}
          className={trail.length ? "text-muted-foreground hover:text-foreground" : "font-medium"}
        >
          Media
        </button>
        {trail.map((f, i) => (
          <span key={f.id} className="flex items-center gap-1">
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            <button
              type="button"
              onClick={() => onNavigate(f.id)}
              className={i === trail.length - 1 ? "font-medium" : "text-muted-foreground hover:text-foreground"}
            >
              {f.name}
            </button>
          </span>
        ))}
      </nav>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search files"
            className="pl-8"
            aria-label="Search files"
            data-testid="media-search"
          />
        </div>
        <div className="flex rounded-lg border p-0.5" role="tablist" aria-label="File type" data-testid="media-filter">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={filter === f.id}
              onClick={() => onFilter(f.id)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                filter === f.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        {canManage && (
          <>
            <Button type="button" variant="outline" size="sm" onClick={onNewFolder} data-testid="media-new-folder">
              <FolderPlus className="mr-1 h-4 w-4" />New folder
            </Button>
            <Button type="button" size="sm" onClick={onUpload} data-testid="media-upload-button">
              <Upload className="mr-1 h-4 w-4" />Upload
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
