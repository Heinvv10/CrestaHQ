"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MergeFieldMenu } from "./merge-field-menu";
import { insertAtCursor } from "@/lib/messaging/insert-at-cursor";
import { saveSnippet } from "@/lib/snippets/client";
import {
  SNIPPET_BODY_MAX,
  SNIPPET_FOLDER_MAX,
  SNIPPET_NAME_MAX,
  SNIPPET_SUBJECT_MAX,
  validateSnippet,
} from "@/lib/snippets/validate";
import type { SnippetDto, SnippetType } from "@/types/snippets";

export type EditorTarget =
  | { mode: "create"; type: SnippetType }
  | { mode: "edit"; snippet: SnippetDto };

/**
 * Create / edit one snippet. The merge-field picker inserts RAW tags at the
 * body's caret — a snippet is a template; tags render when it is inserted
 * into a conversation.
 */
export function SnippetEditorDialog({
  subAccountId,
  target,
  folders,
  onClose,
  onSaved,
}: {
  subAccountId: string;
  target: EditorTarget | null;
  folders: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [folder, setFolder] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const type: SnippetType =
    target?.mode === "edit" ? target.snippet.type : (target?.type ?? "text");

  useEffect(() => {
    const s = target?.mode === "edit" ? target.snippet : null;
    setName(s?.name ?? "");
    setSubject(s?.subject ?? "");
    setFolder(s?.folder ?? "");
    setBody(s?.body ?? "");
    setError(null);
  }, [target]);

  function insertTag(tag: string) {
    const el = bodyRef.current;
    const next = insertAtCursor(
      body,
      tag,
      el?.selectionStart ?? null,
      el?.selectionEnd ?? null
    );
    setBody(next.value);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(next.caret, next.caret);
    });
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const v = validateSnippet({ type, name, body, subject, folder });
    if (!v.ok) {
      setError(v.error);
      return;
    }
    setSaving(true);
    try {
      await saveSnippet(
        subAccountId,
        v.value,
        target?.mode === "edit" ? target.snippet.id : undefined
      );
      toast.success(
        target?.mode === "edit" ? "Snippet saved." : "Snippet created."
      );
      onSaved();
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Couldn't save the snippet."
      );
    } finally {
      setSaving(false);
    }
  }

  const kind = type === "email" ? "Email" : "Text";
  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="space-y-3">
          <DialogHeader>
            <DialogTitle>
              {target?.mode === "edit"
                ? `Edit ${kind.toLowerCase()} snippet`
                : `Add ${kind} Snippet`}
            </DialogTitle>
            <DialogDescription>
              Merge fields fill in from the contact when the snippet is
              inserted.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1">
            <Label htmlFor="snippet-name">Name</Label>
            <Input
              id="snippet-name"
              value={name}
              maxLength={SNIPPET_NAME_MAX}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {type === "email" && (
            <div className="space-y-1">
              <Label htmlFor="snippet-subject">Subject</Label>
              <Input
                id="snippet-subject"
                value={subject}
                maxLength={SNIPPET_SUBJECT_MAX}
                onChange={(e) => setSubject(e.target.value)}
              />
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="snippet-folder">Folder (optional)</Label>
            <Input
              id="snippet-folder"
              list="snippet-folders"
              value={folder}
              maxLength={SNIPPET_FOLDER_MAX}
              placeholder="e.g. Sales"
              onChange={(e) => setFolder(e.target.value)}
            />
            <datalist id="snippet-folders">
              {folders.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <Label htmlFor="snippet-body">Body</Label>
              <MergeFieldMenu onPick={insertTag} />
            </div>
            <Textarea
              id="snippet-body"
              ref={bodyRef}
              value={body}
              rows={6}
              maxLength={SNIPPET_BODY_MAX}
              onChange={(e) => setBody(e.target.value)}
              className="min-h-32 text-sm"
            />
          </div>
          {error && (
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
