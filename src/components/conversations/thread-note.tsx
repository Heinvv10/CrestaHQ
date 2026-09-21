"use client";

import { StickyNote } from "lucide-react";
import { toDate } from "@/lib/format";
import { splitMentions } from "@/lib/conversations/note-mentions";
import type { Note } from "@/types/contacts";

/**
 * An internal note inline in the conversation thread (SP2 T2). Deliberately
 * NOT a chat bubble: full width, dashed amber card, "Internal note" label — an
 * operator must never mistake it for something the customer saw.
 * `mentionNames` are the display names of the note's `mentionedUids`; each
 * `@Name` for one of them is highlighted.
 */
export function ThreadNote({
  note,
  mentionNames = [],
}: {
  note: Note;
  mentionNames?: string[];
}) {
  const ts = toDate(note.createdAt);
  return (
    <div
      data-testid="thread-note"
      className="mx-auto w-full max-w-[90%] rounded-lg border border-dashed border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm"
    >
      <div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
        <StickyNote className="h-3 w-3" />
        <span>Internal note · not sent</span>
        {ts && (
          <span className="text-muted-foreground font-normal">
            ·{" "}
            {ts.toLocaleString(undefined, {
              hour: "numeric",
              minute: "2-digit",
              month: "short",
              day: "numeric",
            })}
          </span>
        )}
      </div>
      <p className="break-words whitespace-pre-wrap">
        {splitMentions(note.content, mentionNames).map((part, i) =>
          part.mention ? (
            <span
              key={i}
              data-testid="note-mention"
              className="rounded bg-amber-500/25 px-0.5 font-medium text-amber-800 dark:text-amber-300"
            >
              {part.text}
            </span>
          ) : (
            part.text
          )
        )}
      </p>
    </div>
  );
}
