"use client";

import { useMemo, useRef, useState, type DragEvent } from "react";
import { ImageIcon } from "lucide-react";
import { toast } from "sonner";
import { useMediaLibrary } from "@/hooks/use-media-library";
import { mediaApi } from "@/lib/media/api";
import { MEDIA_ACCEPT, precheckMediaFile, uploadMediaFile } from "@/lib/media/upload";
import type { MediaAssetDoc, MediaFolderDoc } from "@/types/media";
import { ConfirmDeleteDialog, MoveDialog, NameDialog, PreviewDialog } from "./media-dialogs";
import { AssetTile, FolderTile, type AssetAction, type FolderAction } from "./media-tile";
import { MediaToolbar, type KindFilter } from "./media-toolbar";
import { UploadProgress, type UploadItem } from "./upload-progress";

/**
 * The library grid shared by the Media page and the picker dialog. Folders
 * first, then files, scoped to the open folder; search and the type filter
 * run over the whole library so a match in another folder is still found.
 * In `selectable` mode a click hands the asset to `onSelect` instead of
 * opening the preview. Without `canManage` (a non-admin member) the library
 * is read-only: no upload, no folders, only Preview / Copy link.
 */
export function MediaLibrary({
  subAccountId,
  canManage,
  selectable = false,
  accept = "any",
  onSelect,
}: {
  subAccountId: string;
  canManage: boolean;
  selectable?: boolean;
  accept?: "image" | "any";
  onSelect?: (asset: MediaAssetDoc) => void;
}) {
  const { assets, folders, error, hydrated } = useMediaLibrary(subAccountId);
  const api = useMemo(() => mediaApi(subAccountId), [subAccountId]);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<KindFilter>(accept === "image" ? "image" : "all");
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [renameAsset, setRenameAsset] = useState<MediaAssetDoc | null>(null);
  const [renameFolder, setRenameFolder] = useState<MediaFolderDoc | null>(null);
  const [moveAsset, setMoveAsset] = useState<MediaAssetDoc | null>(null);
  const [preview, setPreview] = useState<MediaAssetDoc | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<
    { kind: "asset"; doc: MediaAssetDoc } | { kind: "folder"; doc: MediaFolderDoc } | null
  >(null);

  const searching = search.trim().length > 0;
  const visibleFolders = useMemo(
    () => (searching ? [] : folders.filter((f) => (f.parentId ?? null) === folderId)),
    [folders, folderId, searching],
  );
  const visibleAssets = useMemo(() => {
    const q = search.trim().toLowerCase();
    return assets.filter((a) => {
      if (accept === "image" && a.kind !== "image") return false;
      if (filter !== "all" && a.kind !== filter) return false;
      if (q) return a.name.toLowerCase().includes(q);
      return (a.folderId ?? null) === folderId;
    });
  }, [assets, accept, filter, search, folderId]);

  /** Toast the outcome; resolves true on success so a dialog knows to close. */
  function run(label: string, p: Promise<unknown>): Promise<boolean> {
    return p.then(
      () => (toast.success(label), true),
      (err: unknown) => (toast.error(err instanceof Error ? err.message : "Something went wrong."), false),
    );
  }

  function patchUpload(id: string, patch: Partial<UploadItem>) {
    setUploads((list) => list.map((u) => (u.id === id ? { ...u, ...patch } : u)));
  }

  async function uploadFiles(files: File[]) {
    const accepted = files.filter((f) => {
      const refusal = accept === "image" && !f.type.startsWith("image/")
        ? `${f.name}: choose an image.`
        : precheckMediaFile(f);
      if (refusal) toast.error(refusal);
      return !refusal;
    });
    await Promise.all(
      accepted.map(async (file) => {
        const id = crypto.randomUUID();
        setUploads((list) => [...list, { id, name: file.name, fraction: 0, status: "uploading" }]);
        try {
          await uploadMediaFile(file, subAccountId, folderId, (fraction) => patchUpload(id, { fraction }));
          patchUpload(id, { fraction: 1, status: "done" });
          setTimeout(() => setUploads((list) => list.filter((u) => u.id !== id)), 4000);
        } catch (err) {
          patchUpload(id, { status: "error", error: err instanceof Error ? err.message : "Upload failed." });
        }
      }),
    );
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    if (!canManage) return;
    void uploadFiles(Array.from(e.dataTransfer.files));
  }

  function onAssetAction(asset: MediaAssetDoc, action: AssetAction) {
    if (action === "preview") setPreview(asset);
    if (action === "rename") setRenameAsset(asset);
    if (action === "move") setMoveAsset(asset);
    if (action === "delete") setDeleteTarget({ kind: "asset", doc: asset });
    if (action === "copy") {
      void navigator.clipboard.writeText(asset.downloadUrl).then(
        () => toast.success("Link copied"),
        () => toast.error("Couldn't copy the link."),
      );
    }
  }

  function onFolderAction(folder: MediaFolderDoc, action: FolderAction) {
    if (action === "rename") setRenameFolder(folder);
    if (action === "delete") setDeleteTarget({ kind: "folder", doc: folder });
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const { kind, doc } = deleteTarget;
    setDeleteTarget(null);
    await run(
      kind === "asset" ? "File deleted" : "Folder deleted",
      kind === "asset" ? api.remove(doc.id) : api.removeFolder(doc.id),
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border bg-card p-5 text-sm" data-testid="media-load-error">
        <p className="text-rose-600 dark:text-rose-400">Couldn&apos;t load the media library.</p>
        <p className="mt-1 text-xs text-muted-foreground">{error.message}</p>
      </div>
    );
  }
  if (!hydrated) {
    return <div className="h-64 animate-pulse rounded-2xl bg-muted/40" data-testid="media-loading" />;
  }

  const empty = visibleFolders.length === 0 && visibleAssets.length === 0;

  return (
    <div className="space-y-4">
      <MediaToolbar
        folders={folders}
        currentFolderId={folderId}
        search={search}
        filter={filter}
        onNavigate={(id) => { setFolderId(id); setSearch(""); }}
        onSearch={setSearch}
        onFilter={setFilter}
        canManage={canManage}
        onNewFolder={() => setNewFolderOpen(true)}
        onUpload={() => inputRef.current?.click()}
      />
      {canManage && (
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={accept === "image" ? "image/*" : MEDIA_ACCEPT}
          className="hidden"
          data-testid="media-upload-input"
          onChange={(e) => {
            void uploadFiles(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
      )}

      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(canManage); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`min-h-[240px] rounded-2xl border-2 border-dashed p-3 transition-colors ${
          dragging ? "border-primary bg-primary/5" : "border-transparent"
        }`}
        data-testid="media-grid"
      >
        {empty ? (
          <div className="flex h-56 flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
            <ImageIcon className="h-8 w-8" />
            <p>{searching ? "No files match your search." : canManage ? "No files here yet. Drop files or click Upload." : "No files here yet."}</p>
          </div>
        ) : (
          <>
            {visibleFolders.length > 0 && (
              <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                {visibleFolders.map((f) => (
                  <FolderTile
                    key={f.id}
                    folder={f}
                    canManage={canManage}
                    onOpen={() => setFolderId(f.id)}
                    onAction={(a) => onFolderAction(f, a)}
                  />
                ))}
              </div>
            )}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
              {visibleAssets.map((a) => (
                <AssetTile
                  key={a.id}
                  asset={a}
                  canManage={canManage}
                  onOpen={() => (selectable && onSelect ? onSelect(a) : setPreview(a))}
                  onAction={(action) => onAssetAction(a, action)}
                />
              ))}
            </div>
          </>
        )}
      </div>

      <UploadProgress items={uploads} />

      <NameDialog
        open={newFolderOpen}
        title="New folder"
        label="Folder name"
        submitLabel="Create"
        testId="media-new-folder-dialog"
        onOpenChange={setNewFolderOpen}
        onSubmit={(name) => run("Folder created", api.createFolder(name, folderId))}
      />
      <NameDialog
        open={renameAsset !== null}
        title="Rename file"
        label="Name"
        initial={renameAsset?.name ?? ""}
        submitLabel="Save"
        testId="media-rename-dialog"
        onOpenChange={(o) => !o && setRenameAsset(null)}
        onSubmit={(name) => run("Renamed", api.rename(renameAsset!.id, name))}
      />
      <NameDialog
        open={renameFolder !== null}
        title="Rename folder"
        label="Folder name"
        initial={renameFolder?.name ?? ""}
        submitLabel="Save"
        testId="media-rename-folder-dialog"
        onOpenChange={(o) => !o && setRenameFolder(null)}
        onSubmit={(name) => run("Renamed", api.renameFolder(renameFolder!.id, name))}
      />
      <MoveDialog
        asset={moveAsset}
        folders={folders}
        onOpenChange={(o) => !o && setMoveAsset(null)}
        onSubmit={(target) => run("Moved", api.move(moveAsset!.id, target))}
      />
      <PreviewDialog asset={preview} onOpenChange={(o) => !o && setPreview(null)} />
      <ConfirmDeleteDialog
        name={deleteTarget?.doc.name ?? ""}
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
