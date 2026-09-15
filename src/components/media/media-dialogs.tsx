"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { MediaAssetDoc, MediaFolderDoc } from "@/types/media";
import { AssetThumb } from "./media-tile";

/** One text field + submit — used for "New folder" and both renames. */
export function NameDialog({
  open,
  title,
  label,
  initial = "",
  submitLabel,
  testId,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  title: string;
  label: string;
  initial?: string;
  submitLabel: string;
  testId: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (name: string) => Promise<boolean>;
}) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    e.stopPropagation(); // never submit a form the picker is nested inside
    const name = value.trim();
    if (!name) return;
    setBusy(true);
    try {
      if (await onSubmit(name)) onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={submit} className="space-y-4" data-testid={testId}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <div>
            <Label htmlFor={`${testId}-name`}>{label}</Label>
            <Input
              id={`${testId}-name`}
              autoFocus
              maxLength={120}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !value.trim()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function MoveDialog({
  asset,
  folders,
  onOpenChange,
  onSubmit,
}: {
  asset: MediaAssetDoc | null;
  folders: MediaFolderDoc[];
  onOpenChange: (open: boolean) => void;
  onSubmit: (folderId: string | null) => Promise<boolean>;
}) {
  const [target, setTarget] = useState<string>("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (asset) setTarget(asset.folderId ?? "");
  }, [asset]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    e.stopPropagation(); // never submit a form the picker is nested inside
    setBusy(true);
    try {
      if (await onSubmit(target || null)) onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={asset !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={submit} className="space-y-4" data-testid="media-move-dialog">
          <DialogHeader>
            <DialogTitle>Move to folder</DialogTitle>
            <DialogDescription className="truncate">{asset?.name}</DialogDescription>
          </DialogHeader>
          <div>
            <Label htmlFor="media-move-target">Folder</Label>
            <select
              id="media-move-target"
              className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            >
              <option value="">Media (root)</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Move"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function PreviewDialog({
  asset,
  onOpenChange,
}: {
  asset: MediaAssetDoc | null;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={asset !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl" data-testid="media-preview-dialog">
        <DialogHeader>
          <DialogTitle className="truncate">{asset?.name}</DialogTitle>
          <DialogDescription>{asset?.contentType}</DialogDescription>
        </DialogHeader>
        {asset && (
          <div className="max-h-[70vh] overflow-hidden rounded-lg bg-muted">
            {asset.kind === "image" && <AssetThumb asset={asset} className="max-h-[70vh] object-contain" />}
            {asset.kind === "video" && (
              <video src={asset.downloadUrl} controls className="max-h-[70vh] w-full" />
            )}
            {asset.kind === "document" && (
              <iframe src={asset.downloadUrl} title={asset.name} sandbox="" className="h-[70vh] w-full" />
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ConfirmDeleteDialog({
  name,
  open,
  onOpenChange,
  onConfirm,
}: {
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<unknown>;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="media-delete-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “{name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            This can&apos;t be undone. Anything linking to this file will stop working.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => void onConfirm()} data-testid="media-delete-confirm">
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
