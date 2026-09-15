"use client";

import { useState } from "react";
import { Copy, Link2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SNAPSHOT_SHARE_EXPIRY_DAYS } from "@/types/snapshots";

const selectClass =
  "h-9 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

interface Props {
  snapshot: { id: string; name: string } | null;
  onOpenChange: (open: boolean) => void;
  /** Called after a link is created so the Shared tab can refresh. */
  onCreated: () => void;
}

/**
 * Create a share link for one snapshot. The URL carries the only copy of the
 * token — once this dialog closes it cannot be shown again, only revoked.
 */
export function SnapshotShareDialog({ snapshot, onOpenChange, onCreated }: Props) {
  const [expiresInDays, setExpiresInDays] = useState<number>(7);
  const [singleUse, setSingleUse] = useState(false);
  const [creating, setCreating] = useState(false);
  const [url, setUrl] = useState<string | null>(null);

  function handleOpenChange(open: boolean) {
    if (!open) {
      setUrl(null);
      setExpiresInDays(7);
      setSingleUse(false);
    }
    onOpenChange(open);
  }

  async function handleCreate() {
    if (!snapshot || creating) return;
    setCreating(true);
    try {
      const res = await fetch(`/api/agency/snapshots/${snapshot.id}/shares`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expiresInDays, singleUse }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
      };
      if (!res.ok || !data.url) throw new Error(data.error ?? "Could not create link.");
      setUrl(data.url);
      onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create link.");
    } finally {
      setCreating(false);
    }
  }

  async function copyUrl() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Share link copied.");
    } catch {
      toast.error("Clipboard blocked — select the link and copy manually.");
    }
  }

  return (
    <Dialog open={snapshot !== null} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Share &ldquo;{snapshot?.name}&rdquo;</DialogTitle>
          <DialogDescription>
            Anyone who owns an agency and opens this link can import a copy of
            the snapshot. Customer data and credentials are never included.
          </DialogDescription>
        </DialogHeader>

        {url ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Copy it now — the link is shown only once. You can revoke it from
              the Shared tab.
            </p>
            <div className="flex gap-2">
              <Input
                readOnly
                value={url}
                data-testid="snapshot-share-url"
                onFocus={(e) => e.currentTarget.select()}
                className="h-9 font-mono text-xs"
              />
              <Button variant="outline" className="h-9" onClick={copyUrl}>
                <Copy className="mr-1 h-3.5 w-3.5" />
                Copy
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-4">
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Link expires after
              <select
                className={selectClass}
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(Number(e.target.value))}
              >
                {SNAPSHOT_SHARE_EXPIRY_DAYS.map((d) => (
                  <option key={d} value={d}>
                    {d === 1 ? "1 day" : `${d} days`}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex h-9 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={singleUse}
                onChange={(e) => setSingleUse(e.target.checked)}
              />
              Single use
            </label>
          </div>
        )}

        <DialogFooter>
          {url ? (
            <Button variant="outline" onClick={() => handleOpenChange(false)}>
              Done
            </Button>
          ) : (
            <Button onClick={handleCreate} disabled={creating}>
              {creating ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Link2 className="mr-1 h-3.5 w-3.5" />
              )}
              Create link
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
