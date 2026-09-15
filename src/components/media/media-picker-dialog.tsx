"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { MediaAssetDoc } from "@/types/media";
import { MediaLibrary } from "./media-library";

/**
 * Pick a file from the sub-account's Media Library. The same grid as the
 * Media page (admins can upload from inside the picker); clicking a tile hands
 * the asset to `onSelect` and closes the dialog.
 */
export function MediaPickerDialog({
  subAccountId,
  canManage,
  open,
  onOpenChange,
  accept = "any",
  onSelect,
}: {
  subAccountId: string;
  /** Sub-account admin: may upload from inside the picker. */
  canManage: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accept?: "image" | "any";
  onSelect: (asset: MediaAssetDoc) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl" data-testid="media-picker">
        <DialogHeader>
          <DialogTitle>Choose from library</DialogTitle>
          <DialogDescription>
            {accept === "image" ? "Pick an image, or upload a new one." : "Pick a file, or upload a new one."}
          </DialogDescription>
        </DialogHeader>
        {open && (
          <MediaLibrary
            subAccountId={subAccountId}
            canManage={canManage}
            selectable
            accept={accept}
            onSelect={(asset) => {
              onSelect(asset);
              onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
