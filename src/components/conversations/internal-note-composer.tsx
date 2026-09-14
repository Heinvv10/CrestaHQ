"use client";

import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { Loader2, StickyNote } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useSubAccount } from "@/context/sub-account-context";
import { useSubAccountMembers } from "@/hooks/use-sub-account-members";
import { addNote } from "@/lib/firestore/contacts";
import {
  activeMentionQuery,
  filterMentionCandidates,
  mentionedUidsIn,
} from "@/lib/conversations/note-mentions";
import type { AssignableMember } from "@/types";
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
 *
 * Typing `@` + letters offers the sub-account's active members; a picked
 * member still named in the text is stored in `mentionedUids`, and the
 * mention-tasks route then tasks each of them (it re-reads the note and
 * re-checks membership — nothing here is trusted).
 */
export function InternalNoteComposer({
  contactId,
  toggle,
}: {
  contactId: string;
  toggle: React.ReactNode;
}) {
  const { user } = useAuth();
  const { subAccountId } = useSubAccount();
  const { members } = useSubAccountMembers(subAccountId);
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [caret, setCaret] = useState(0);
  const [picked, setPicked] = useState<AssignableMember[]>([]);
  const [active, setActive] = useState(0);
  // The `@` whose list was dismissed with Esc; a new `@` reopens.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const mention = activeMentionQuery(body, caret);
  const candidates =
    mention && mention.start !== dismissedAt
      ? filterMentionCandidates(members, mention.query)
      : [];
  const open = candidates.length > 0;

  function pick(member: AssignableMember) {
    if (!mention) return;
    const inserted = `@${member.displayName} `;
    const next = body.slice(0, mention.start) + inserted + body.slice(caret);
    const at = mention.start + inserted.length;
    setBody(next);
    setCaret(at);
    setActive(0);
    setPicked((prev) => [...prev.filter((p) => p.uid !== member.uid), member]);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(at, at);
    });
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (!open) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + step + candidates.length) % candidates.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      pick(candidates[Math.min(active, candidates.length - 1)]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setDismissedAt(mention!.start);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = body.trim();
    if (!trimmed || saving || !user) return;
    setSaving(true);
    const mentionedUids = mentionedUidsIn(trimmed, picked);
    try {
      const noteId = await addNote(
        contactId,
        trimmed,
        user.uid,
        "conversation",
        mentionedUids
      );
      setBody("");
      setPicked([]);
      if (mentionedUids.length > 0) {
        const res = await fetch(
          `/api/sub-accounts/${subAccountId}/contacts/${contactId}/notes/${noteId}/mention-tasks`,
          { method: "POST" }
        );
        if (!res.ok) {
          const payload = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          toast.error(
            `Note saved, but the mentioned teammates weren't notified: ${
              payload.error ?? `HTTP ${res.status}`
            }`
          );
        }
      }
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
      <div className="relative">
        <Textarea
          ref={textareaRef}
          aria-label="Internal note"
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            setActive(0);
            setCaret(e.target.selectionStart ?? e.target.value.length);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onKeyDown={handleKeyDown}
          placeholder="Internal note — only your team sees this. Nothing is sent. Type @ to mention a teammate."
          rows={2}
          disabled={saving}
          className="min-h-[60px] resize-none border-amber-500/40 px-3 py-2 text-sm"
        />
        {open && (
          <ul
            role="listbox"
            aria-label="Mention a teammate"
            className="bg-popover absolute bottom-full left-0 z-10 mb-1 w-64 overflow-hidden rounded-md border py-1 text-sm shadow-md"
          >
            {candidates.map((m, i) => (
              <li
                key={m.uid}
                role="option"
                aria-selected={i === active}
                // mousedown, not click: keep the textarea's focus + caret.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(m);
                }}
                className={cn(
                  "cursor-pointer px-3 py-1.5",
                  i === active && "bg-accent text-accent-foreground"
                )}
              >
                {m.displayName}
              </li>
            ))}
          </ul>
        )}
      </div>
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
