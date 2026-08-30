"use client";

import { useCallback, useEffect, useState } from "react";
import { Camera, Layers, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface SubOption {
  id: string;
  name: string;
  accountNumber?: number;
}

interface SnapshotSummary {
  id: string;
  name: string;
  description: string;
  sourceSubAccountId: string | null;
  createdAt: number | null;
  counts: {
    forms: number;
    messageTemplates: number;
    products: number;
    workflows: number;
  };
}

const selectClass =
  "h-9 rounded-md border border-input bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring";

/**
 * Agency-owner panel: capture a sub-account's reusable config (forms, message
 * templates, products, workflows) into a snapshot. Captured snapshots are
 * applied at sub-account CREATION time via the "Start from a snapshot" picker
 * on the new sub-account form — this panel is the capture + library surface.
 * Mirrors GoHighLevel's "snapshot" — build a proven setup once, deploy it to
 * every new client. Customer data + credentials are never copied.
 */
export function SnapshotsSection({ subs }: { subs: SubOption[] }) {
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const [sourceId, setSourceId] = useState("");
  const [name, setName] = useState("");
  const [capturing, setCapturing] = useState(false);

  const subLabel = useCallback(
    (id: string | null) => {
      if (!id) return "—";
      const s = subs.find((x) => x.id === id);
      if (!s) return id.slice(0, 8);
      return s.accountNumber ? `#${s.accountNumber} ${s.name}` : s.name;
    },
    [subs],
  );

  const loadSnapshots = useCallback(async () => {
    try {
      const res = await fetch("/api/agency/snapshots");
      const data = (await res.json().catch(() => ({}))) as {
        snapshots?: SnapshotSummary[];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Failed to load snapshots.");
      setSnapshots(data.snapshots ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSnapshots();
  }, [loadSnapshots]);

  async function handleCapture() {
    if (capturing) return;
    if (!sourceId) {
      toast.error("Pick a sub-account to capture from.");
      return;
    }
    if (!name.trim()) {
      toast.error("Give the snapshot a name.");
      return;
    }
    setCapturing(true);
    try {
      const res = await fetch("/api/agency/snapshots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceSubAccountId: sourceId, name: name.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        counts?: SnapshotSummary["counts"];
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Capture failed.");
      const c = data.counts;
      toast.success(
        c
          ? `Captured ${c.forms} forms, ${c.workflows} workflows, ${c.messageTemplates} templates, ${c.products} products.`
          : "Snapshot captured.",
      );
      setName("");
      await loadSnapshots();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Capture failed.");
    } finally {
      setCapturing(false);
    }
  }

  return (
    <section className="rounded-2xl border bg-card p-5">
      <div className="mb-4 flex items-center gap-2">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Layers className="h-4 w-4" />
        </span>
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">Snapshots</h2>
            <span className="rounded-full bg-fuchsia-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-fuchsia-600 dark:text-fuchsia-400">
              Beta
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Capture a sub-account&apos;s forms, workflows, message templates, and
            products into a reusable template, then apply it to another
            sub-account. Customer data and credentials are never copied.
          </p>
        </div>
      </div>

      {/* Capture */}
      <div className="mb-4 space-y-3 rounded-lg border bg-background p-4">
        <p className="text-sm font-medium">Capture a snapshot</p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            From sub-account
            <select
              className={selectClass}
              value={sourceId}
              onChange={(e) => setSourceId(e.target.value)}
            >
              <option value="">Select…</option>
              {subs.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.accountNumber ? `#${s.accountNumber} ` : ""}
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
            Snapshot name
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Plumber starter setup"
              className="h-9"
            />
          </label>
          <Button onClick={handleCapture} disabled={capturing} className="h-9">
            {capturing ? (
              <>
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                Capturing…
              </>
            ) : (
              <>
                <Camera className="mr-1 h-3.5 w-3.5" />
                Capture
              </>
            )}
          </Button>
        </div>
      </div>

      {/* List + apply */}
      <div className="space-y-2">
        {loading ? (
          <div className="h-20 animate-pulse rounded-lg bg-muted/50" />
        ) : snapshots.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No snapshots yet. Capture one above.
          </p>
        ) : (
          snapshots.map((snap) => (
            <div
              key={snap.id}
              className="rounded-lg border bg-background p-4"
            >
              <p className="truncate text-sm font-medium">{snap.name}</p>
              <p className="text-xs text-muted-foreground">
                {snap.counts.forms} forms · {snap.counts.workflows} workflows ·{" "}
                {snap.counts.messageTemplates} templates ·{" "}
                {snap.counts.products} products · from{" "}
                {subLabel(snap.sourceSubAccountId)}
              </p>
            </div>
          ))
        )}
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        Apply a snapshot when you{" "}
        <strong>create a new sub-account</strong> — pick it from the{" "}
        &ldquo;Start from a snapshot&rdquo; dropdown on the new sub-account form.
        Imported workflows arrive as <strong>drafts</strong> — review and
        activate them in the new sub-account. A workflow triggered by a form in
        the same snapshot is auto-linked to the imported form; any other
        form/WhatsApp-template reference is cleared for you to reconnect.
      </p>
    </section>
  );
}
