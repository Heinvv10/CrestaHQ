"use client";

import { useMemo, useState, type FormEvent } from "react";
import { Download, Loader2, Tag, Trash2, UserRound, X } from "lucide-react";
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
import { AssigneeSelect } from "@/components/assignee-select";
import { useSubAccount } from "@/context/sub-account-context";
import type { Contact } from "@/types/contacts";

type Pending =
  | { kind: "add_tag" | "remove_tag" }
  | { kind: "assign" }
  | { kind: "delete" };

interface Props {
  /** The selected contacts (already resolved from the visible set). */
  contacts: Contact[];
  /** Every loaded contact — only used to suggest existing tags. */
  allContacts: Contact[];
  canDelete: boolean;
  onClear: () => void;
  onExport: () => void;
}

interface BulkAction {
  type: "add_tag" | "remove_tag" | "assign" | "delete";
  tag?: string;
  assignedToUid?: string | null;
}

/**
 * Appears once at least one row is selected. Every write goes through
 * POST /api/contacts/bulk, which verifies tenancy for the whole batch
 * before touching anything.
 */
export function BulkActionsBar({
  contacts,
  allContacts,
  canDelete,
  onClear,
  onExport,
}: Props) {
  const { subAccountId } = useSubAccount();
  const [pending, setPending] = useState<Pending | null>(null);
  const [tags, setTags] = useState("");
  const [assignee, setAssignee] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const count = contacts.length;

  const knownTags = useMemo(() => {
    const set = new Set<string>();
    for (const c of allContacts) for (const t of c.tags ?? []) set.add(t);
    return [...set].sort();
  }, [allContacts]);

  const open = (p: Pending) => {
    setTags("");
    setAssignee(null);
    setPending(p);
  };
  const close = () => {
    if (!busy) setPending(null);
  };

  async function run(action: BulkAction): Promise<boolean> {
    const res = await fetch("/api/contacts/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subAccountId,
        ids: contacts.map((c) => c.id),
        action,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      deleted?: number;
      blocked?: { id: string }[];
    };
    if (!res.ok) {
      toast.error(body.error ?? "Bulk action failed.");
      return false;
    }
    if (action.type === "delete") {
      const blocked = body.blocked?.length ?? 0;
      toast.success(
        blocked > 0
          ? `Deleted ${body.deleted}. ${blocked} skipped — still linked to deals, tasks or quotes.`
          : `Deleted ${body.deleted} contact${body.deleted === 1 ? "" : "s"}`,
      );
    } else {
      toast.success(`Updated ${count} contact${count === 1 ? "" : "s"}`);
    }
    return true;
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!pending) return;
    setBusy(true);
    try {
      let ok = true;
      if (pending.kind === "add_tag" || pending.kind === "remove_tag") {
        const list = [...new Set(tags.split(",").map((t) => t.trim()).filter(Boolean))];
        if (list.length === 0) return;
        // One request per tag: the route takes a single tag so its trigger
        // diff stays per-tag, exactly like the single-contact path.
        for (const tag of list) {
          ok = await run({ type: pending.kind, tag });
          if (!ok) break;
        }
      } else if (pending.kind === "assign") {
        ok = await run({ type: "assign", assignedToUid: assignee });
      } else {
        ok = await run({ type: "delete" });
      }
      if (ok) {
        setPending(null);
        onClear();
      }
    } finally {
      setBusy(false);
    }
  }

  if (count === 0) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-xl border bg-card px-3 py-2"
      data-testid="bulk-actions-bar"
    >
      <span className="text-sm font-medium">{count} selected</span>
      <Button type="button" variant="ghost" size="sm" onClick={() => open({ kind: "add_tag" })}>
        <Tag className="mr-1 h-3.5 w-3.5" /> Add tag
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => open({ kind: "remove_tag" })}>
        <Tag className="mr-1 h-3.5 w-3.5" /> Remove tag
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => open({ kind: "assign" })}>
        <UserRound className="mr-1 h-3.5 w-3.5" /> Assign to
      </Button>
      {canDelete && (
        <Button type="button" variant="ghost" size="sm" onClick={() => open({ kind: "delete" })}>
          <Trash2 className="mr-1 h-3.5 w-3.5" /> Delete
        </Button>
      )}
      <Button type="button" variant="ghost" size="sm" onClick={onExport}>
        <Download className="mr-1 h-3.5 w-3.5" /> Export
      </Button>
      <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={onClear} aria-label="Clear selection">
        <X className="h-3.5 w-3.5" />
      </Button>

      <Dialog open={pending !== null} onOpenChange={(o) => !o && close()}>
        <DialogContent>
          <form onSubmit={submit} className="space-y-4">
            <DialogHeader>
              <DialogTitle>
                {pending?.kind === "add_tag" && `Add tag to ${count} contact${count === 1 ? "" : "s"}`}
                {pending?.kind === "remove_tag" && `Remove tag from ${count} contact${count === 1 ? "" : "s"}`}
                {pending?.kind === "assign" && `Assign ${count} contact${count === 1 ? "" : "s"}`}
                {pending?.kind === "delete" && `Delete ${count} contact${count === 1 ? "" : "s"}?`}
              </DialogTitle>
              <DialogDescription>
                {pending?.kind === "delete"
                  ? "Their notes, activities and messages go with them. Contacts still linked to a deal, task or quote are skipped."
                  : pending?.kind === "assign"
                    ? "Sets the owner on every selected contact."
                    : "Comma-separate several tags."}
              </DialogDescription>
            </DialogHeader>
            {(pending?.kind === "add_tag" || pending?.kind === "remove_tag") && (
              <>
                <Input
                  id="bulk-tags"
                  list="bulk-known-tags"
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  placeholder="vip, newsletter"
                  autoFocus
                />
                <datalist id="bulk-known-tags">
                  {knownTags.map((t) => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
              </>
            )}
            {pending?.kind === "assign" && (
              <AssigneeSelect id="bulk-assignee" value={assignee} onChange={setAssignee} />
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={close} disabled={busy}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant={pending?.kind === "delete" ? "destructive" : "default"}
                disabled={busy}
              >
                {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                {pending?.kind === "delete" ? `Delete ${count}` : "Apply"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
