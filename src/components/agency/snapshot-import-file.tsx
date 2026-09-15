"use client";

import { useRef, useState } from "react";
import { Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/** Mirrors SNAPSHOT_FILE_MAX_BYTES; the server enforces it, this saves the upload. */
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * "Import from file": a snapshot file downloaded from any deployment's share
 * page. The server validates and scrubs it; this only reads it and posts it.
 */
export function SnapshotImportFile({ onImported }: { onImported: () => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);

  async function handleFile(file: File | undefined) {
    if (!file || importing) return;
    if (file.size > MAX_BYTES) {
      toast.error("That file is over 5 MB — it isn't a snapshot file.");
      return;
    }
    setImporting(true);
    try {
      const res = await fetch("/api/agency/snapshots/import-file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: await file.text(),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Import failed.");
      toast.success(
        "Snapshot imported. Reconfigure workflow notification recipients and webhook URLs before activating.",
      );
      await onImported();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed.");
    } finally {
      setImporting(false);
      if (input.current) input.current.value = "";
    }
  }

  return (
    <>
      <input
        ref={input}
        type="file"
        accept="application/json,.json"
        className="hidden"
        aria-label="Snapshot file"
        data-testid="snapshot-import-file-input"
        onChange={(e) => void handleFile(e.target.files?.[0])}
      />
      <Button
        variant="outline"
        size="sm"
        disabled={importing}
        onClick={() => input.current?.click()}
      >
        {importing ? (
          <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
        ) : (
          <Upload className="mr-1 h-3.5 w-3.5" />
        )}
        Import from file
      </Button>
    </>
  );
}
