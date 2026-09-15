"use client";

import { Images } from "lucide-react";
import { useSubAccount } from "@/context/sub-account-context";
import { MediaLibrary } from "@/components/media/media-library";

/**
 * Media Library — every file this sub-account has uploaded (images, videos,
 * PDFs), in folders, with live updates. Members browse it; admins manage it.
 */
export default function MediaPage() {
  const { subAccountId, isAdmin, loading } = useSubAccount();

  if (loading) {
    return (
      <div className="mx-auto w-full max-w-5xl space-y-6">
        <div className="h-7 w-48 animate-pulse rounded bg-muted" />
        <div className="h-64 animate-pulse rounded-2xl bg-muted/40" />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6">
      <header>
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-sky-500/10 text-sky-600 dark:text-sky-400">
            <Images className="h-4 w-4" />
          </span>
          <h1 className="text-2xl font-bold tracking-tight">Media</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Images, videos and PDFs for this workspace — up to 25 MB each. Use
          them anywhere a file is asked for.
        </p>
      </header>
      <MediaLibrary subAccountId={subAccountId} canManage={isAdmin} />
    </div>
  );
}
