"use client";

import { FileText, Folder, MoreVertical, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { MediaAssetDoc, MediaFolderDoc } from "@/types/media";

export type AssetAction = "preview" | "copy" | "rename" | "move" | "delete";
export type FolderAction = "rename" | "delete";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function Kebab<T extends string>({
  label,
  items,
  onAction,
}: {
  label: string;
  items: Array<{ id: T; label: string; destructive?: boolean }>;
  onAction: (a: T) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1 h-7 w-7 bg-background/80 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100"
          />
        }
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
      >
        <MoreVertical className="h-4 w-4" />
      </DropdownMenuTrigger>
      {/* Stop clicks here: React bubbles them through the portal to the tile. */}
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        {items.map((item, i) => (
          <div key={item.id}>
            {item.destructive && i > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem
              onClick={() => onAction(item.id)}
              className={cn(item.destructive && "text-destructive focus:text-destructive")}
            >
              {item.label}
            </DropdownMenuItem>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function AssetThumb({ asset, className }: { asset: MediaAssetDoc; className?: string }) {
  if (asset.kind === "image") {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- Firebase Storage token URL
      <img
        src={asset.downloadUrl}
        alt={asset.name}
        loading="lazy"
        className={cn("h-full w-full object-cover", className)}
      />
    );
  }
  const Icon = asset.kind === "video" ? Video : FileText;
  return (
    <div className={cn("flex h-full w-full items-center justify-center bg-muted text-muted-foreground", className)}>
      <Icon className="h-10 w-10" />
    </div>
  );
}

const ASSET_ITEMS: Array<{ id: AssetAction; label: string; destructive?: boolean }> = [
  { id: "preview", label: "Preview" },
  { id: "copy", label: "Copy link" },
  { id: "rename", label: "Rename" },
  { id: "move", label: "Move to folder" },
  { id: "delete", label: "Delete", destructive: true },
];

export function AssetTile({
  asset,
  canManage,
  onOpen,
  onAction,
}: {
  asset: MediaAssetDoc;
  canManage: boolean;
  onOpen: () => void;
  onAction: (a: AssetAction) => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
      className="group relative overflow-hidden rounded-xl border bg-card text-left outline-none transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="media-tile"
      data-name={asset.name}
      data-media-id={asset.id}
    >
      <div className="aspect-square w-full overflow-hidden">
        <AssetThumb asset={asset} />
      </div>
      <div className="space-y-0.5 p-2">
        <p className="truncate text-xs font-medium" title={asset.name}>{asset.name}</p>
        <p className="text-[11px] text-muted-foreground">{formatBytes(asset.size)}</p>
      </div>
      <Kebab
        label={`Actions for ${asset.name}`}
        items={canManage ? ASSET_ITEMS : ASSET_ITEMS.filter((i) => i.id === "preview" || i.id === "copy")}
        onAction={onAction}
      />
    </div>
  );
}

const FOLDER_ITEMS: Array<{ id: FolderAction; label: string; destructive?: boolean }> = [
  { id: "rename", label: "Rename" },
  { id: "delete", label: "Delete", destructive: true },
];

export function FolderTile({
  folder,
  canManage,
  onOpen,
  onAction,
}: {
  folder: MediaFolderDoc;
  canManage: boolean;
  onOpen: () => void;
  onAction: (a: FolderAction) => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
      className="group relative flex items-center gap-2 rounded-xl border bg-card p-3 text-left outline-none transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="media-folder-tile"
      data-name={folder.name}
      data-folder-id={folder.id}
    >
      <Folder className="h-5 w-5 shrink-0 text-amber-500" />
      <span className="truncate pr-6 text-sm font-medium" title={folder.name}>{folder.name}</span>
      {canManage && <Kebab label={`Actions for folder ${folder.name}`} items={FOLDER_ITEMS} onAction={onAction} />}
    </div>
  );
}
