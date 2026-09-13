"use client";

import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Loader2, StickyNote } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { addNote } from "@/lib/firestore/contacts";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export type ComposerMode = "reply" | "note";

/**
 * Reply / Internal note switch at the top of the thread composer (SP2 T2 —
 * GHL's "Internal Comment" tab).
 */
export function ComposerModeToggle({
  mode,
  onChange,
}: {
  mode: ComposerMode;
  onChange: (mode: ComposerMode) => void;
}) {
  const tabs: { value: ComposerMode; label: string }[] = [
    { value: "reply", label: "Reply" },
    { value: "note", label: "Internal note" },
  ];
  return (
    <div role="tablist" aria-label="Composer mode" className="mb-2 flex gap-3">
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={mode === t.value}
          onClick={() => onChange(t.value)}
          className={cn(
            "border-b-2 pb-0.5 text-xs font-medium transition-colors",
            mode === t.value
              ? t.value === "note"
                ? "border-amber-500 text-amber-700 dark:text-amber-400"
                : "border-primary text-foreground"
              : "text-muted-foreground hover:text-foreground border-transparent"
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Internal note mode. Writes a contact note (`contacts/{id}/notes`, the same
 * rows the contact timeline shows) marked `source: "conversation"`. It has no
 * channel, no recipient and no send route — nothing here can reach the
 * customer. Works even when no messaging channel is configured.
 */
export function InternalNoteComposer({
  contactId,
  toggle,
}: {
  contactId: string;
  toggle: React.ReactNode;
}) {
  const { user } = useAuth();
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = body.trim();
    if (!trimmed || saving || !user) return;
    setSaving(true);
    try {
      await addNote(contactId, trimmed, user.uid, "conversation");
      setBody("");
    } catch (err) {
      toast.error(
        err instanceof Error
          ? `Couldn't save the note: ${err.message}`
          : "Couldn't save the note."
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="border-t bg-amber-500/5 px-4 py-3"
      data-testid="internal-note-composer"
    >
      {toggle}
      <Textarea
        aria-label="Internal note"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Internal note — only your team sees this. Nothing is sent."
        rows={2}
        disabled={saving}
        className="min-h-[60px] resize-none border-amber-500/40 px-3 py-2 text-sm"
      />
      <div className="mt-2 flex justify-end">
        <Button type="submit" size="sm" disabled={!body.trim() || saving || !user}>
          {saving ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <StickyNote className="mr-1 h-3.5 w-3.5" />
          )}
          Save note
        </Button>
      </div>
    </form>
  );
}
