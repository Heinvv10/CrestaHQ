"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Mail, MessageSquareText, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { deleteSnippet } from "@/lib/snippets/client";
import { AgentEditBadge } from "./agent-edit-badge";
import type { SnippetDto } from "@/types/snippets";

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/** GHL-style snippet table: Name · Body · Folder · Type · Date Updated. */
export function SnippetsTable({
  subAccountId,
  snippets,
  onEdit,
  onDeleted,
}: {
  subAccountId: string;
  snippets: SnippetDto[];
  onEdit: (s: SnippetDto) => void;
  onDeleted: () => void;
}) {
  const [pending, setPending] = useState<SnippetDto | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function confirmDelete() {
    if (!pending) return;
    setDeleting(true);
    try {
      await deleteSnippet(subAccountId, pending.id);
      toast.success("Snippet deleted.");
      setPending(null);
      onDeleted();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't delete the snippet."
      );
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <div className="bg-card overflow-x-auto rounded-xl border">
        <table className="w-full text-sm" data-testid="snippets-table">
          <thead className="text-muted-foreground border-b text-left text-xs">
            <tr>
              <th className="px-3 py-2 font-medium">Name</th>
              <th className="px-3 py-2 font-medium">Body</th>
              <th className="px-3 py-2 font-medium">Folder</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 font-medium">Date Updated</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {snippets.map((s) => (
              <tr
                key={s.id}
                data-testid="snippet-row"
                className="border-b last:border-0"
              >
                <td className="px-3 py-2 font-medium">
                  {s.name} <AgentEditBadge snippet={s} />
                </td>
                <td className="text-muted-foreground max-w-xs truncate px-3 py-2">
                  {s.body}
                </td>
                <td className="px-3 py-2">{s.folder ?? "—"}</td>
                <td className="px-3 py-2">
                  <span className="inline-flex items-center gap-1 text-xs">
                    {s.type === "email" ? (
                      <Mail className="h-3.5 w-3.5" />
                    ) : (
                      <MessageSquareText className="h-3.5 w-3.5" />
                    )}
                    {s.type === "email" ? "Email" : "Text"}
                  </span>
                </td>
                <td className="text-muted-foreground px-3 py-2 text-xs whitespace-nowrap">
                  {s.updatedAt ? dateFmt.format(new Date(s.updatedAt)) : "—"}
                </td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Edit ${s.name}`}
                    onClick={() => onEdit(s)}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Delete ${s.name}`}
                    onClick={() => setPending(s)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Dialog
        open={!!pending}
        onOpenChange={(open) => !open && setPending(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete snippet?</DialogTitle>
            <DialogDescription>
              &ldquo;{pending?.name}&rdquo; will be removed for everyone in this
              sub-account.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={() => void confirmDelete()}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
