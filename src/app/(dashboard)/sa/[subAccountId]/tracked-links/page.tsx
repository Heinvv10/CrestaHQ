"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Check, Copy, Link2, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSubAccount } from "@/context/sub-account-context";

/**
 * Tracked links — the GHL "Trigger Link" equivalent. Create a link, copy it
 * into an outbound message, and a click fires the `link.clicked` workflow
 * trigger.
 *
 * The URL copied here is the UNATTRIBUTED form (`/l/{id}`) — it records a
 * click but enrols nobody, because there's no contact attached. Per-contact
 * URLs are minted by POST /api/v1/links/{id}/recipients at send time.
 */

interface TrackedLinkRow {
  id: string;
  name: string;
  destinationUrl: string;
  clickCount: number;
  lastClickedAt: string | null;
}

export default function TrackedLinksPage() {
  const { subAccountId } = useSubAccount();
  const [links, setLinks] = useState<TrackedLinkRow[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const res = await fetch(`/api/sub-accounts/${subAccountId}/tracked-links`);
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { links: TrackedLinkRow[] };
      setLinks(data.links);
    } catch {
      toast.error("Could not load tracked links.");
    } finally {
      setLoading(false);
    }
  }, [subAccountId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Tracked links</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          A short link that records every click and can start a workflow. Put
          one in an email or WhatsApp message and use the &ldquo;Tracked link
          clicked&rdquo; trigger to act on it.
        </p>
      </div>

      <CreateForm subAccountId={subAccountId} onCreated={reload} />

      {loading ? (
        <div className="text-muted-foreground flex justify-center py-16">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : links.length === 0 ? (
        <div className="bg-card rounded-2xl border p-12 text-center">
          <Link2 className="text-muted-foreground mx-auto h-10 w-10" />
          <h2 className="mt-4 text-base font-semibold">No tracked links yet</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Create one above to start measuring clicks.
          </p>
        </div>
      ) : (
        <div className="bg-card overflow-x-auto rounded-2xl border">
          <table className="w-full text-sm">
            <thead className="bg-muted/30 text-muted-foreground border-b text-left text-xs tracking-wider uppercase">
              <tr>
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-4 py-2.5 font-medium">Destination</th>
                <th className="px-4 py-2.5 text-right font-medium">Clicks</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {links.map((l) => (
                <LinkRow
                  key={l.id}
                  link={l}
                  subAccountId={subAccountId}
                  onDeleted={reload}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function CreateForm({
  subAccountId,
  onCreated,
}: {
  subAccountId: string;
  onCreated: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [destinationUrl, setDestinationUrl] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/tracked-links`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, destinationUrl }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to create.");
      setName("");
      setDestinationUrl("");
      toast.success("Tracked link created.");
      await onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="bg-card flex flex-col gap-3 rounded-2xl border p-4 sm:flex-row sm:items-end"
    >
      <div className="flex-1 space-y-1.5">
        <Label htmlFor="link-name">Name</Label>
        <Input
          id="link-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Audit — EDC Engineers"
        />
      </div>
      <div className="flex-1 space-y-1.5">
        <Label htmlFor="link-destination">Destination URL</Label>
        <Input
          id="link-destination"
          value={destinationUrl}
          onChange={(e) => setDestinationUrl(e.target.value)}
          placeholder="https://example.com/report"
        />
      </div>
      <Button type="submit" disabled={saving}>
        {saving ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Plus className="h-4 w-4" />
        )}
        Create
      </Button>
    </form>
  );
}

function LinkRow({
  link,
  subAccountId,
  onDeleted,
}: {
  link: TrackedLinkRow;
  subAccountId: string;
  onDeleted: () => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(
        `${window.location.origin}/l/${link.id}`,
      );
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Could not copy the link.");
    }
  }

  async function remove() {
    setBusy(true);
    try {
      const res = await fetch(
        `/api/sub-accounts/${subAccountId}/tracked-links/${link.id}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error("Failed to delete.");
      toast.success("Tracked link deleted.");
      await onDeleted();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className="border-b last:border-0">
      <td className="px-4 py-3 font-medium">{link.name}</td>
      <td className="text-muted-foreground max-w-md truncate px-4 py-3">
        {link.destinationUrl}
      </td>
      <td className="px-4 py-3 text-right tabular-nums">{link.clickCount}</td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-1">
          <Button size="sm" variant="ghost" onClick={copy} title="Copy link">
            {copied ? (
              <Check className="h-3.5 w-3.5" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={remove}
            title="Delete"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </td>
    </tr>
  );
}
